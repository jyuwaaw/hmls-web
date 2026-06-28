import { Hono } from "hono";
import { convertToModelMessages } from "ai";
import { eq } from "drizzle-orm";
import { runHmlsAgent, type UserContext } from "@hmls/agent";
import { db, schema } from "@hmls/agent/db";
import { routeOrderToShop } from "@hmls/agent/common/shop-routing";
import { Errors } from "@hmls/shared/errors";
import { getLogger } from "@logtape/logtape";
import { type AuthUserEnv, requireAuthUser } from "../middleware/auth.ts";

const logger = getLogger(["hmls", "gateway", "chat"]);

/** Look up customer by authUserId (preferred) or unique email, or create one if not found.
 *  Returns the customer context AND their shopId (resolved from the DB row,
 *  or stamped at creation using the primary shop).
 *
 *  Email fallback is guarded: we only bind when EXACTLY ONE customer row matches
 *  the email to prevent cross-shop mis-binding when two shops share an email. */
async function resolveCustomer(
  userInfo: { email: string; authUserId: string; name?: string; phone?: string },
): Promise<{ ctx: UserContext; shopId: string } | undefined> {
  if (!userInfo.email) return undefined;

  // 1. Preferred: match by auth_user_id (fast, unambiguous).
  let existing = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.authUserId, userInfo.authUserId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // 2. Email fallback: only bind when EXACTLY ONE row matches — avoids cross-shop
  //    mis-binding when multiple shops have a customer with the same email.
  if (!existing) {
    const emailMatches = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.email, userInfo.email))
      .limit(2);
    if (emailMatches.length === 1) {
      existing = emailMatches[0];
      // Self-heal: stamp auth_user_id so the fallback is not needed next time.
      await db
        .update(schema.customers)
        .set({ authUserId: userInfo.authUserId })
        .where(eq(schema.customers.id, existing.id));
    }
    // 0 or ≥2 matches → existing stays null → create a new customer below.
  }

  if (existing) {
    // Use the customer's assigned shopId (shopId is NOT NULL per migration 0029).
    return {
      ctx: {
        id: existing.id,
        name: existing.name ?? userInfo.name ?? "",
        email: existing.email ?? userInfo.email,
        phone: existing.phone ?? userInfo.phone ?? "",
      },
      shopId: existing.shopId,
    };
  }

  // 3. No match — create a new customer stamped with the primary shop.
  const { shopId } = await routeOrderToShop(null);

  const [created] = await db
    .insert(schema.customers)
    .values({
      name: userInfo.name || null,
      email: userInfo.email,
      phone: userInfo.phone || null,
      shopId,
      authUserId: userInfo.authUserId,
    })
    .returning();

  return {
    ctx: {
      id: created.id,
      name: created.name ?? "",
      email: created.email ?? userInfo.email,
      phone: created.phone ?? "",
    },
    shopId: created.shopId,
  };
}

const chat = new Hono<AuthUserEnv>();

// AI SDK data stream endpoint
chat.post("/", requireAuthUser, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    const raw = await c.req.text().catch(() => "<unreadable>");
    logger.error("JSON parse failed", { error: String(e), rawBody: raw.slice(0, 500) });
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      400,
    );
  }

  const { messages } = body;
  if (!messages || !Array.isArray(messages)) {
    logger.error("Validation failed", {
      messagesType: typeof messages,
      bodyKeys: Object.keys(body),
    });
    throw Errors.validation("Invalid request", "messages array is required");
  }

  // Admins have their own chat (/api/admin/chat) and must not mix message
  // history into the customer-facing HMLS agent. Block here as defense in
  // depth; the web UI also redirects admins to /admin/chat.
  const authUser = c.get("authUser");
  if (authUser.role === "admin") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Admins must use the admin chat at /admin/chat",
        },
      },
      403,
    );
  }

  // Resolve authenticated user -> customer record (upsert on first contact).
  const resolved = await resolveCustomer({ email: authUser.email, authUserId: authUser.id });
  const userContext = resolved?.ctx;
  const shopId = resolved?.shopId;

  const startTime = Date.now();
  const userId = userContext?.id ?? authUser.email;
  const messageCount = messages.length;
  logger.info("Request received", { userId, shopId, messageCount });

  try {
    const modelMessages = await convertToModelMessages(messages);

    const result = await runHmlsAgent({
      messages: modelMessages,
      userContext,
      shopId,
    });

    // onError logs the real provider failure; without it AI SDK masks every
    // mid-stream error (DeepSeek 429/402/context-length) as a generic string
    // with nothing in the logs. Return value is the (unchanged) client message.
    const response = result.toUIMessageStreamResponse({
      onError: (error) => {
        logger.error("Agent stream error", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return "An error occurred.";
      },
    });
    const duration = Date.now() - startTime;
    logger.info("Request finished", { userId, messageCount, duration });
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("Agent failed", {
      userId,
      messageCount,
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

export { chat };
