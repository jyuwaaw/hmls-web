import { Hono } from "hono";
import { convertToModelMessages } from "ai";
import { runStaffAgent } from "@hmls/agent";
import { db, schema, withAdminScope, withTenantScope } from "@hmls/agent/db";
import { and, eq } from "drizzle-orm";
import { canonicalizeStatus } from "@hmls/shared/order/status";
import { Errors } from "@hmls/shared/errors";
import { getLogger } from "@logtape/logtape";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";
import { OWNER_ALL_SHOPS, requireShopContext, type WithShop } from "../middleware/shop-context.ts";

const logger = getLogger(["hmls", "gateway", "staff-chat"]);

/** Compact, human-readable order summary injected into the staff agent's
 *  system prompt when the chat is embedded on an order detail page (PR 6).
 *  Pure — unit tested. */
export function formatOrderContext(
  order: typeof schema.orders.$inferSelect, // tenant-ok: type-only reference
  providerName: string | null,
): string {
  const money = (cents: number | null | undefined) => `$${((cents ?? 0) / 100).toFixed(2)}`;
  const status = canonicalizeStatus(order.status);
  const vehicle = order.vehicleInfo
    ? [order.vehicleInfo.year, order.vehicleInfo.make, order.vehicleInfo.model]
      .filter(Boolean).join(" ") || "unknown"
    : "unknown";
  const items = Array.isArray(order.items) ? order.items : [];
  const itemLines = items.map((it) =>
    `  - ${it.name} (${it.category}) x${it.quantity} @ ${money(it.unitPriceCents)}`
  );
  const schedule = order.scheduledAt
    ? `${new Date(order.scheduledAt).toISOString()}${
      order.durationMinutes ? ` (${order.durationMinutes} min)` : ""
    }${order.location ? ` at ${order.location}` : ""}`
    : "not scheduled";
  const mechanic = order.providerId != null
    ? `${providerName ?? "unknown"} (#${order.providerId})`
    : "unassigned";
  const payment = order.paidAt
    ? `paid ${money(order.paidAmountCents)} (${order.paymentMethod ?? "unknown"}) on ${
      new Date(order.paidAt).toISOString()
    }`
    : "unpaid";
  return [
    `Order #${order.id}`,
    `- Status: ${status} (revision ${order.revisionNumber})`,
    `- Customer: ${order.contactName ?? "unknown"}${
      order.contactPhone ? ` · ${order.contactPhone}` : ""
    }`,
    `- Vehicle: ${vehicle}`,
    `- Items (subtotal ${money(order.subtotalCents)}):`,
    ...(itemLines.length > 0 ? itemLines : ["  - (none)"]),
    `- Schedule: ${schedule}`,
    `- Mechanic: ${mechanic}`,
    `- Payment: ${payment}`,
  ].join("\n");
}

/** Fetch the order for the seed with a SHORT-LIVED shop-scoped query — the
 *  same per-call pattern the agent tools use (convert-tools.ts). Deliberately
 *  NOT router-level withTenantTx: this route streams, and a streaming request
 *  must not hold a transaction open. Returns the formatted context, or null
 *  when the order doesn't exist or belongs to another shop (caller 404s
 *  without leaking existence). */
export async function loadOrderContext(
  orderId: number,
  shopId: string,
): Promise<string | null> {
  const fetchSeed = async () => {
    // Explicit shop predicate as well as RLS scope — belt and braces, and
    // keeps cross-shop 404 correct in envs where the tenant client falls
    // back to the service role (local dev / CI).
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(
        shopId === OWNER_ALL_SHOPS
          ? eq(schema.orders.id, orderId)
          : and(eq(schema.orders.id, orderId), eq(schema.orders.shopId, shopId)),
      )
      .limit(1);
    if (!order) return null;
    let providerName: string | null = null;
    if (order.providerId != null) {
      const [p] = await db
        .select({ name: schema.providers.name })
        .from(schema.providers)
        .where(
          and(
            eq(schema.providers.id, order.providerId),
            eq(schema.providers.shopId, order.shopId),
          ),
        )
        .limit(1);
      providerName = p?.name ?? null;
    }
    return formatOrderContext(order, providerName);
  };
  return shopId === OWNER_ALL_SHOPS
    ? await withAdminScope(fetchSeed)
    : await withTenantScope({ shopId }, fetchSeed);
}

const staffChat = new Hono<WithShop<AdminEnv>>();

staffChat.use("*", requireAdmin);
staffChat.use("*", requireShopContext);

// Staff chat endpoint — requires admin JWT + shop context
staffChat.post("/", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      400,
    );
  }

  const { messages, orderId } = body;
  if (!messages || !Array.isArray(messages)) {
    throw Errors.validation("Invalid request", "messages array is required");
  }

  const authUser = c.get("authUser");
  const shopId = c.get("shopId");
  const startTime = Date.now();
  logger.info("Request received", {
    userId: authUser.id,
    shopId,
    messageCount: messages.length,
    orderId: orderId ?? null,
  });

  // Embedded order chat (PR 6): seed the agent with the order the chat is
  // mounted on. Cross-shop / nonexistent / malformed ids all 404 BEFORE any
  // stream starts, with the same shape (don't leak existence).
  let orderContext: string | undefined;
  if (orderId != null) {
    const id = Number(orderId);
    const context = Number.isInteger(id) && id > 0 ? await loadOrderContext(id, shopId) : null;
    if (!context) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Order not found" } },
        404,
      );
    }
    orderContext = context;
  }

  try {
    const modelMessages = await convertToModelMessages(messages);

    const result = await runStaffAgent({
      messages: modelMessages,
      adminEmail: authUser.email ?? undefined,
      shopId,
      orderContext,
    });

    // onError logs the real provider failure; without it AI SDK masks every
    // mid-stream error (DeepSeek 429/402/context-length) as a generic string
    // with nothing in the logs. Return value is the (unchanged) client message.
    const response = result.toUIMessageStreamResponse({
      onError: (error) => {
        logger.error("Agent stream error", {
          userId: authUser.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return "An error occurred.";
      },
    });
    const duration = Date.now() - startTime;
    logger.info("Request finished", {
      userId: authUser.id,
      messageCount: messages.length,
      duration,
    });
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("Agent failed", {
      userId: authUser.id,
      duration,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json(
      {
        error: {
          code: "AGENT_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    );
  }
});

export { staffChat };
