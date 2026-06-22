import { Hono } from "hono";
import { db, schema } from "@hmls/agent/db";
import { and, eq } from "drizzle-orm";
import { EstimatePdf } from "@hmls/agent";
import { transition } from "@hmls/agent/order-state";
import { Errors } from "@hmls/shared/errors";
import { type AuthEnv, requireAuth } from "../middleware/auth.ts";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import { pdfResponse } from "../lib/pdf-response.ts";

// After Layer 3 "estimate" is a VIEW on the `orders` table — there is no
// separate `estimates` table anymore. The routes below still live under
// `/estimates/:id` for URL compat but the :id parameter is an order ID.
//
// NOTE: requireShopContext is intentionally NOT mounted here. Public routes
// (/pdf, /review, /approve, /decline) use shareToken as the authorization
// proof — the token IS the auth. The authenticated GET uses customerId
// ownership. There is no shop context to resolve from an anonymous caller
// holding a share-token link, and scoping by shopId would break those links.

const estimates = new Hono<AuthEnv>();

// GET /estimates/:id — authenticated owner view of an order
estimates.get("/:id", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const customerId = c.get("customerId");
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (!order) throw Errors.notFound("Order", id);
  if (order.customerId !== customerId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Not authorized to view this order" } },
      403,
    );
  }

  return c.json(order);
});

// GET /estimates/:id/pdf — public via share token only.
// Token is REQUIRED — no token = 404 (do not leak existence).
// Admins use GET /api/admin/orders/:id/pdf instead (auth-guarded, shop-scoped).
estimates.get("/:id/pdf", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const token = c.req.query("token");

  // Require a non-empty token — id-only access is an IDOR (any caller can
  // read any order's PDF by guessing the numeric id).
  if (!token) {
    return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token)))
    .limit(1);

  if (!order) throw Errors.notFound("Order", id);

  const customer = {
    name: order.contactName,
    phone: order.contactPhone,
    email: order.contactEmail,
    address: order.contactAddress,
    vehicleInfo: order.vehicleInfo as
      | { make?: string; model?: string; year?: string }
      | null,
  };

  const items = (order.items as { name: string; description?: string; totalCents: number }[])
    .map((i) => ({
      name: i.name,
      description: i.description ?? "",
      price: i.totalCents ?? 0,
    }));

  return pdfResponse(
    EstimatePdf({
      estimate: {
        id,
        items,
        subtotal: order.subtotalCents ?? 0,
        priceRangeLow: order.priceRangeLowCents ?? 0,
        priceRangeHigh: order.priceRangeHighCents ?? 0,
        notes: order.notes,
        expiresAt: order.expiresAt ?? new Date(),
        createdAt: order.createdAt,
      },
      customer,
    }),
    `HMLS-Estimate-${id}.pdf`,
  );
});

// GET /estimates/:id/review — public review page via share token
estimates.get("/:id/review", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const token = c.req.query("token");
  if (!token) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Token required" } }, 400);
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token)))
    .limit(1);

  if (!order) {
    return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  return c.json({
    estimate: {
      id,
      items: order.items,
      subtotal: order.subtotalCents,
      priceRangeLow: order.priceRangeLowCents,
      priceRangeHigh: order.priceRangeHighCents,
      vehicleInfo: order.vehicleInfo,
      notes: order.notes,
      expiresAt: order.expiresAt,
      createdAt: order.createdAt,
    },
    customerName: order.contactName,
    orderId: order.id,
    orderStatus: order.status,
  });
});

// Share-token approval/decline — caller is not authenticated but holds a
// token that proves they received the estimate. Authority derives from the
// token; ownership check is the token-match SELECT below.
async function assertTokenValid(
  id: number,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const [row] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token)))
    .limit(1);
  return row != null;
}

// POST /estimates/:id/approve — share-token approval
estimates.post("/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const token = c.req.query("token");
  if (!(await assertTokenValid(id, token))) {
    return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }
  const result = await transition(id, "approved", { kind: "share_token", orderId: id });
  if (!result.ok) return sendOrderStateResult(c, result);
  return c.json({ success: true, order: result.value });
});

// POST /estimates/:id/decline — share-token decline
estimates.post("/:id/decline", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const token = c.req.query("token");
  if (!(await assertTokenValid(id, token))) {
    return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }
  const body = await c.req.json<{ reason?: string }>().catch(
    () => ({} as { reason?: string }),
  );
  const result = await transition(id, "declined", { kind: "share_token", orderId: id }, {
    reason: body.reason,
  });
  if (!result.ok) return sendOrderStateResult(c, result);
  return c.json({ success: true, order: result.value });
});

export { estimates };
