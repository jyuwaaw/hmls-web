import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, dbAdmin, schema, withAdminScope, withTenantScope } from "@hmls/agent/db";
import { and, eq } from "drizzle-orm";
import { EstimatePdf } from "@hmls/agent";
import { transition } from "@hmls/agent/order-state";
import { Errors } from "@hmls/shared/errors";
import { type AuthEnv, requireAuth } from "../middleware/auth.ts";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import { pdfResponse } from "../lib/pdf-response.ts";
import { geocodeAddress } from "@hmls/agent/common/shop-routing";

const ZIP_ONLY = /^\d{5}(-\d{4})?$/;
/** An estimate whose stored location is a bare ZIP still needs a street address before approval. */
function needsAddress(order: { status: string; location: string | null }): boolean {
  return order.status === "estimated" && !!order.location && ZIP_ONLY.test(order.location.trim());
}

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
  // withTenantScope: authenticated customer reading their OWN order. Sets
  // app.customer_id so the orders RLS policy admits their row (across shops).
  // Per-handler wrap, NOT a router-wide withTenantTx — the sibling public
  // token routes have no customerId and would throw under a router-wide scope.
  // (The trailing tenant-ok annotation sits on the query line itself so the
  // tenant-guard statement scan sees the scope was applied deliberately.)
  const [order] = await withTenantScope(
    { customerId },
    () => db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1), // tenant-ok: app.customer_id set by the withTenantScope wrap; RLS enforces ownership
  );

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

  // dbAdmin: a shareToken is a capability, not a shop scope — there is no
  // requireShopContext on this router, so no tenant GUC would be set. The
  // token-match WHERE clause below is the authorization proof.
  const [order] = await dbAdmin
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

  // dbAdmin: public share-token route (no requireShopContext on this router,
  // so no tenant GUC would be set). The token-match WHERE clause is the auth.
  const [order] = await dbAdmin
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
    needsAddress: needsAddress(order),
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
  // dbAdmin: public share-token capability check — no shop context to scope by.
  const [row] = await dbAdmin
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token)))
    .limit(1);
  return row != null;
}

const approveInput = z.object({ address: z.string().min(3).optional() });

// POST /estimates/:id/approve — share-token approval
estimates.post("/:id/approve", zValidator("json", approveInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const token = c.req.query("token");
  const { address } = c.req.valid("json");

  // dbAdmin: public share-token route (no requireShopContext on this router,
  // so no tenant GUC would be set). The token-match WHERE clause below is the
  // authorization proof (replaces the separate assertTokenValid existence check
  // — we need the full row anyway for the address gate below).
  const [order] = await dbAdmin
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token ?? "")))
    .limit(1);
  if (!order) {
    return c.json({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Zip-only estimate must gain a street address before approval — otherwise
  // staff would dispatch on centroid-only precision. Same gate as the
  // authenticated portal approve route (portal.ts).
  if (needsAddress(order)) {
    if (!address) {
      return c.json(
        {
          error: { code: "ADDRESS_REQUIRED", message: "A service address is required to approve." },
        },
        400,
      );
    }
    const coords = await geocodeAddress(address);
    const outOfArea = !coords; // best-effort; a miss just flags for staff, never blocks
    await dbAdmin.update(schema.orders).set({
      location: address,
      locationLat: coords ? String(coords.lat) : order.locationLat,
      locationLng: coords ? String(coords.lng) : order.locationLng,
      adminNotes: outOfArea
        ? [order.adminNotes, "⚠ Approval address did not geocode — verify before dispatch."]
          .filter(Boolean).join("\n")
        : order.adminNotes,
    }).where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token ?? ""))); // tenant-ok: share-token capability re-checked in the WHERE clause
  }

  // withAdminScope: share-token caller has no shop context, so transition()'s
  // internal reads/writes would be denied under fail-closed RLS. The token was
  // just validated above; run the state change on the admin (bypass) connection.
  const result = await withAdminScope(() =>
    transition(id, "approved", { kind: "share_token", orderId: id })
  );
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
  // withAdminScope: see the /approve handler — token-authed, no shop context,
  // so transition()'s reads/writes run on the admin (bypass) connection.
  const result = await withAdminScope(() =>
    transition(id, "declined", { kind: "share_token", orderId: id }, {
      reason: body.reason,
    })
  );
  if (!result.ok) return sendOrderStateResult(c, result);
  return c.json({ success: true, order: result.value });
});

export { estimates };
