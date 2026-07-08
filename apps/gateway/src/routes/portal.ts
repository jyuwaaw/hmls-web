import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, schema } from "@hmls/agent/db";
import { desc, eq } from "drizzle-orm";
import { Errors } from "@hmls/shared/errors";
import { type AuthEnv, requireAuth } from "../middleware/auth.ts";
import { requireShopContext, type WithShop } from "../middleware/shop-context.ts";
import { withTenantTx } from "../middleware/with-tenant-tx.ts";
import { transition } from "@hmls/agent/order-state";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import { geocodeAddress } from "@hmls/agent/common/shop-routing";
import { orderReasonInput, updateProfileInput } from "@hmls/shared/api/contracts/portal";
import type {
  CustomerRow,
  OrderEventRow,
  OrderIntakeRow,
  OrderRow,
  OrderRowWithIntake,
} from "@hmls/shared/db/types";

type ApiError = { error: { code: string; message: string } };

const ZIP_ONLY = /^\d{5}(-\d{4})?$/;
/** An estimate whose stored location is a bare ZIP still needs a street address before approval. */
function needsAddress(order: { status: string; location: string | null }): boolean {
  return order.status === "estimated" && !!order.location && ZIP_ONLY.test(order.location.trim());
}

const portal = new Hono<WithShop<AuthEnv>>();

portal.use("*", requireAuth);
portal.use("*", requireShopContext);
portal.use("*", withTenantTx("customer"));

// GET /me — current customer profile
portal.get("/me", async (c) => {
  const customerId = c.get("customerId");
  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  if (!customer) throw Errors.notFound("Customer", customerId);
  return c.json<CustomerRow>(customer);
});

// PUT /me — update customer profile
portal.put("/me", zValidator("json", updateProfileInput), async (c) => {
  const customerId = c.get("customerId");
  const data = c.req.valid("json");

  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.phone !== undefined) updates.phone = data.phone;
  if (data.address !== undefined) updates.address = data.address;
  if (data.vehicleInfo !== undefined) updates.vehicleInfo = data.vehicleInfo;

  if (Object.keys(updates).length === 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "No fields to update" } },
      400,
    );
  }

  const [updated] = await db
    .update(schema.customers)
    .set(updates)
    .where(eq(schema.customers.id, customerId))
    .returning();

  if (!updated) throw Errors.notFound("Customer", customerId);
  return c.json<CustomerRow>(updated);
});

// GET /me/bookings — orders with scheduling (unified after Layer 3)
// Joins intake so the bookings page can show the customer's own notes
// inline without a per-row roundtrip.
portal.get("/me/bookings", async (c) => {
  const customerId = c.get("customerId");
  const rows = await db
    .select({ order: schema.orders, intake: schema.orderIntake })
    .from(schema.orders)
    .leftJoin(
      schema.orderIntake,
      eq(schema.orderIntake.orderId, schema.orders.id),
    )
    .where(eq(schema.orders.customerId, customerId)) // tenant-ok: customer-owned rows, scoped by customerId across shops; RLS app.customer_id backs it
    .orderBy(desc(schema.orders.scheduledAt));

  // Filter in JS so we still include orders without scheduled_at if none match
  const withIntake: OrderRowWithIntake[] = rows
    .filter((r) => r.order.scheduledAt != null)
    .map((r) => ({ ...r.order, intake: r.intake }));
  return c.json<OrderRowWithIntake[]>(withIntake);
});

// GET /me/orders — customer's orders (unified — replaces estimates + quotes)
portal.get("/me/orders", async (c) => {
  const customerId = c.get("customerId");
  const rows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, customerId)) // tenant-ok: customer-owned rows, scoped by customerId across shops; RLS app.customer_id backs it
    .orderBy(desc(schema.orders.createdAt));

  return c.json<OrderRow[]>(rows);
});

// GET /me/orders/:id — single order detail with events (customer-scoped)
portal.get("/me/orders/:id", async (c) => {
  const customerId = c.get("customerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id)) // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
    .limit(1);

  if (!order || order.customerId !== customerId) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const [events, intake] = await Promise.all([
    db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, id))
      .orderBy(desc(schema.orderEvents.createdAt)),
    db
      .select()
      .from(schema.orderIntake)
      .where(eq(schema.orderIntake.orderId, id))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  return c.json<
    {
      order: OrderRow;
      intake: OrderIntakeRow | null;
      events: OrderEventRow[];
      needsAddress: boolean;
    }
  >({
    order,
    intake,
    events,
    needsAddress: needsAddress(order),
  });
});

// GET /me/estimates — backward compat redirect to orders
portal.get("/me/estimates", async (c) => {
  const customerId = c.get("customerId");
  const rows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, customerId)) // tenant-ok: customer-owned rows, scoped by customerId across shops; RLS app.customer_id backs it
    .orderBy(desc(schema.orders.createdAt));

  return c.json<OrderRow[]>(rows);
});

// GET /me/quotes — backward compat redirect to orders
portal.get("/me/quotes", async (c) => {
  const customerId = c.get("customerId");
  const rows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, customerId)) // tenant-ok: customer-owned rows, scoped by customerId across shops; RLS app.customer_id backs it
    .orderBy(desc(schema.orders.createdAt));

  return c.json<OrderRow[]>(rows);
});

// Harness enforces role-based permission (e.g. "customer may approve
// estimated"). Ownership (this customer owns this specific row) is checked
// inline in each route below — a short SELECT is cheaper than plumbing
// ownership through the harness.

const approveInput = z.object({ address: z.string().min(3).optional() });

// POST /me/orders/:id/approve — customer approves estimate (estimated → approved)
portal.post("/me/orders/:id/approve", zValidator("json", approveInput), async (c) => {
  const customerId = c.get("customerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const { address } = c.req.valid("json");

  // Ownership check — harness handles role-based permission, we handle
  // "this customer owns this row" (ownership is by customerId, cross-shop by design).
  const [order] = await db
    .select() // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);
  if (!order || order.customerId !== customerId) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Zip-only estimate must gain a street address before approval.
  if (needsAddress(order)) {
    if (!address) {
      return c.json<ApiError>(
        {
          error: { code: "ADDRESS_REQUIRED", message: "A service address is required to approve." },
        },
        400,
      );
    }
    const coords = await geocodeAddress(address);
    const outOfArea = !coords; // best-effort; a miss just flags for staff, never blocks
    await db.update(schema.orders).set({
      location: address,
      locationLat: coords ? String(coords.lat) : order.locationLat,
      locationLng: coords ? String(coords.lng) : order.locationLng,
      adminNotes: outOfArea
        ? [order.adminNotes, "⚠ Approval address did not geocode — verify before dispatch."]
          .filter(Boolean).join("\n")
        : order.adminNotes,
    }).where(eq(schema.orders.id, id)); // tenant-ok: customer-owned row; ownership asserted above
  }

  const result = await transition(id, "approved", { kind: "customer", customerId });
  return sendOrderStateResult(c, result);
});

// POST /me/orders/:id/decline — customer declines estimate (estimated → declined)
portal.post("/me/orders/:id/decline", zValidator("json", orderReasonInput), async (c) => {
  const customerId = c.get("customerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const [order] = await db
    .select({ id: schema.orders.id, customerId: schema.orders.customerId }) // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);
  if (!order || order.customerId !== customerId) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const { reason } = c.req.valid("json");
  const result = await transition(id, "declined", { kind: "customer", customerId }, {
    reason,
  });
  return sendOrderStateResult(c, result);
});

// POST /me/orders/:id/cancel-booking — customer cancels a scheduled order
// before the shop has started work.
portal.post(
  "/me/orders/:id/cancel-booking",
  zValidator("json", orderReasonInput),
  async (c) => {
    const customerId = c.get("customerId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
    }

    const [order] = await db
      .select({ id: schema.orders.id, customerId: schema.orders.customerId }) // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order || order.customerId !== customerId) {
      return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
    }

    const { reason } = c.req.valid("json");
    const result = await transition(id, "cancelled", { kind: "customer", customerId }, {
      reason,
    });
    return sendOrderStateResult(c, result);
  },
);

// POST /me/orders/:id/cancel — customer cancels an order they no longer want,
// from the order detail page. The harness gates which states a customer may
// cancel from (draft / estimated / scheduled — never approved/in_progress).
// `cancel-booking` above is the Bookings-page equivalent for scheduled orders.
portal.post("/me/orders/:id/cancel", zValidator("json", orderReasonInput), async (c) => {
  const customerId = c.get("customerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const [order] = await db
    .select({ id: schema.orders.id, customerId: schema.orders.customerId }) // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);
  if (!order || order.customerId !== customerId) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const { reason } = c.req.valid("json");
  const result = await transition(id, "cancelled", { kind: "customer", customerId }, { reason });
  return sendOrderStateResult(c, result);
});

export { portal };
