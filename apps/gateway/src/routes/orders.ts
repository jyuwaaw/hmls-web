import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db, dbAdmin, schema, whereShop } from "@hmls/agent/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";
import { OWNER_ALL_SHOPS, requireShopContext, type WithShop } from "../middleware/shop-context.ts";
import { withTenantTx } from "../middleware/with-tenant-tx.ts";
import { EstimatePdf } from "@hmls/agent";
import type { OrderItem } from "@hmls/agent/db";
import {
  type Actor,
  addNote,
  attachSchedule,
  logContact,
  patchItems,
  physicalStatusLabels,
  recordPayment,
  transition,
} from "@hmls/agent/order-state";
import { autoAssignProvider } from "@hmls/agent/auto-assign";
import { recordOutcome } from "@hmls/agent/fixo-brain";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import { pdfResponse } from "../lib/pdf-response.ts";
import {
  addOrderNoteInput,
  createOrderInput,
  listOrdersQuery,
  logContactInput,
  orderPdfQuery,
  recordPaymentInput,
  scheduleOrderInput,
  transitionOrderInput,
  updateAdminNotesInput,
  updateOrderInput,
} from "@hmls/shared/api/contracts/orders";
import type { OrderDetailRow, OrderEventRow, OrderRow } from "@hmls/shared/db/types";

type ApiError = { error: { code: string; message: string } };

/** Build an admin Actor from the Hono auth context. */
function adminActor(email: string | null | undefined): Actor {
  return { kind: "admin", email: email ?? "admin" };
}

/** Returns true when the order exists and belongs to the given shop (any shop
 *  for the owner-all sentinel — matches the whereShop pattern GET /orders/:id
 *  already uses, so an owner with no shop selected can still read/act on any
 *  order by id). */
async function orderInShop(id: number, shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), whereShop(schema.orders.shopId, shopId)))
    .limit(1);
  return !!row;
}

/** Legacy orders predate the shareToken column. Lazily backfill one before
 *  a lifecycle write so the subsequent notification / PDF link has a valid
 *  token. Separate UPDATE (not inside the harness transaction) keeps the
 *  harness schema-agnostic. */
async function backfillShareTokenIfMissing(orderId: number): Promise<void> {
  const [row] = await db
    .select({ shareToken: schema.orders.shareToken })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (row && !row.shareToken) {
    await db
      .update(schema.orders)
      .set({ shareToken: crypto.randomUUID().replace(/-/g, "") })
      .where(eq(schema.orders.id, orderId)); // tenant-ok: orderId already verified by caller via orderInShop()
  }
}

const orders = new Hono<WithShop<AdminEnv>>();

orders.use("*", requireAdmin);
orders.use("*", requireShopContext);
orders.use("*", withTenantTx("shop"));

// GET /orders — list all orders (with pagination)
orders.get("/", zValidator("query", listOrdersQuery), async (c) => {
  const {
    status,
    search,
    page: rawPage,
    limit: rawLimit,
  } = c.req.valid("query");
  const page = Math.max(1, rawPage ?? 1);
  const limit = Math.min(200, Math.max(1, rawLimit ?? 50));
  const offset = (page - 1) * limit;

  const shopId = c.get("shopId");

  let query = db
    .select()
    .from(schema.orders) // tenant-ok: $dynamic() base; scoped later by conditions[0]=whereShop(shopId) on line 98
    .orderBy(desc(schema.orders.createdAt))
    .$dynamic();

  // whereShop returns undefined for the owner all-shops sentinel, so an owner
  // with no shop selected sees every shop's orders; a concrete shop scopes.
  const conditions: (ReturnType<typeof eq> | undefined)[] = [
    whereShop(schema.orders.shopId, shopId),
  ];
  if (status) {
    // `status` is canonical (zod canonicalizes legacy inputs). Filter on the
    // physical label set so pre-remap rows (still 'scheduled' / 'revised')
    // stay visible during the 9→7 deploy→remap window.
    conditions.push(inArray(schema.orders.status, [...physicalStatusLabels(status)]));
  }
  const searchTerm = search?.trim();
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    const numericId = Number(searchTerm);
    const isNumericId = Number.isInteger(numericId) && numericId > 0;
    // symptomDescription moved to order_intake — search via a correlated
    // EXISTS so we don't have to JOIN the list query for the common
    // (no-search) case.
    const intakeMatch = sql`EXISTS (
      SELECT 1 FROM ${schema.orderIntake}
      WHERE ${schema.orderIntake.orderId} = ${schema.orders.id}
        AND ${schema.orderIntake.symptomDescription} ILIKE ${like}
    )`;
    conditions.push(
      sql`(${schema.orders.contactName} ILIKE ${like}
        OR ${schema.orders.contactEmail} ILIKE ${like}
        OR ${schema.orders.contactPhone} ILIKE ${like}
        OR ${schema.orders.notes} ILIKE ${like}
        OR ${intakeMatch}
        OR ${schema.orders.vehicleInfo}->>'make' ILIKE ${like}
        OR ${schema.orders.vehicleInfo}->>'model' ILIKE ${like}
        OR ${schema.orders.vehicleInfo}->>'year' ILIKE ${like}${
        isNumericId ? sql` OR ${schema.orders.id} = ${numericId}` : sql``
      })`,
    );
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const rows = await query.limit(limit).offset(offset);
  return c.json<OrderRow[]>(rows);
});

// POST /orders — create a new draft order
orders.post("/", zValidator("json", createOrderInput), async (c) => {
  const body = c.req.valid("json");
  const shopId = c.get("shopId");
  if (shopId === OWNER_ALL_SHOPS) {
    return c.json({ error: { code: "NO_SHOP", message: "Select a shop before writing" } }, 400);
  }

  const customerId = body.customer_id;

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.shopId, shopId)))
    .limit(1);

  if (!customer) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Customer not found" } }, 404);
  }

  const vehicleInfo = body.vehicle_year || body.vehicle_make || body.vehicle_model
    ? {
      year: body.vehicle_year ? String(body.vehicle_year) : undefined,
      make: body.vehicle_make ?? undefined,
      model: body.vehicle_model ?? undefined,
    }
    : null;

  const orderItems: OrderItem[] = (body.items ?? []).map((item) => {
    const laborCents = Math.round((item.labor_hours ?? 0) * 140 * 100); // $140/hr default (matches pricing engine)
    const partsCents = Math.round((item.parts_cost ?? 0) * 100);
    const totalCents = laborCents + partsCents;
    return {
      id: crypto.randomUUID(),
      category: "labor" as const,
      name: item.description,
      quantity: 1,
      unitPriceCents: totalCents,
      totalCents,
      taxable: true,
      ...(item.labor_hours ? { laborHours: item.labor_hours } : {}),
    };
  });

  const subtotalCents = orderItems.reduce((sum, i) => sum + i.totalCents, 0);

  const authUser = c.get("authUser");
  const actor = authUser.email ?? "admin";

  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId,
      shopId,
      status: "draft",
      statusHistory: [{ status: "draft", timestamp: new Date().toISOString(), actor }],
      items: orderItems,
      notes: body.description ?? null,
      subtotalCents,
      priceRangeLowCents: Math.round(subtotalCents * 0.9),
      priceRangeHighCents: Math.round(subtotalCents * 1.1),
      vehicleInfo: vehicleInfo ?? undefined,
      shareToken: crypto.randomUUID().replace(/-/g, ""),
      contactName: customer.name ?? null,
      contactEmail: customer.email ?? null,
      contactPhone: customer.phone ?? null,
      contactAddress: customer.address ?? null,
      contactPreferred: customer.preferredContact ?? null,
    })
    .returning();

  // Creation is the one lifecycle write outside the harness — nothing to
  // transition from. Emit the initial status_change event inline so the
  // audit log still has a complete trail.
  await db.insert(schema.orderEvents).values({
    orderId: order.id,
    eventType: "status_change",
    fromStatus: null,
    toStatus: "draft",
    actor: `admin:${actor}`,
    metadata: { itemCount: orderItems.length, source: "admin_post_orders" },
  });

  return c.json<OrderRow>(order, 201);
});

// GET /orders/:id — single order with related entities + events
orders.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), whereShop(schema.orders.shopId, shopId)))
    .limit(1);

  if (!order) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Backfill shareToken if missing (legacy orders)
  if (!order.shareToken) {
    const token = crypto.randomUUID().replace(/-/g, "");
    await db.update(schema.orders).set({ shareToken: token }).where(eq(schema.orders.id, id));
    order.shareToken = token;
  }

  const [customer, events, intake] = await Promise.all([
    order.customerId
      ? db.select().from(schema.customers).where(
        // Scope by the order's shop unless the caller is the cross-shop owner
        // (OWNER_ALL_SHOPS). This prevents a foreign-shop customer profile from
        // leaking when an order is routed to a different shop than the customer's
        // home shop. The order's contact snapshot (contactName/Email/Phone/Address)
        // is always present and serves as the fallback when null is returned here.
        shopId === OWNER_ALL_SHOPS ? eq(schema.customers.id, order.customerId) : and(
          eq(schema.customers.id, order.customerId),
          eq(schema.customers.shopId, order.shopId),
        ),
      ).limit(1).then((r) => r[0])
      : null,
    db.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, id))
      .orderBy(desc(schema.orderEvents.createdAt)),
    db.select().from(schema.orderIntake).where(eq(schema.orderIntake.orderId, id))
      .limit(1).then((r) => r[0] ?? null),
  ]);

  return c.json<OrderDetailRow>({ order, intake, customer: customer ?? null, events });
});

// PATCH /orders/:id — edit items (through harness, lifecycle-aware) and/or
// contact snapshot / metadata fields (direct, status-agnostic).
orders.patch("/:id", zValidator("json", updateOrderInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const body = c.req.valid("json");
  const shopId = c.get("shopId");

  const authUser = c.get("authUser");
  const actor = adminActor(authUser.email);

  // Items + notes go through the harness so revisionNumber, events, and
  // the estimated->draft pullback stay consistent. `autoRevertEstimatedToDraft`
  // is true by default so admin editing an already-sent estimate withdraws it
  // until re-sent.
  const wantsItemEdit = body.items !== undefined || body.notes !== undefined;
  if (wantsItemEdit) {
    // Need the current items if only notes is being changed — harness expects
    // a full items replacement.
    const [current] = await db
      .select({ items: schema.orders.items })
      .from(schema.orders)
      .where(and(eq(schema.orders.id, id), whereShop(schema.orders.shopId, shopId)))
      .limit(1);
    if (!current) {
      return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
    }

    const result = await patchItems(id, {
      items: (body.items as unknown as OrderItem[]) ?? (current.items as OrderItem[] ?? []),
      notes: body.notes,
    }, actor);

    if (!result.ok) {
      // Items path failed — do not apply the direct-field writes either.
      return sendOrderStateResult(c, result);
    }
  }

  // Direct-field writes for fields the harness does not own (contact
  // snapshot, vehicleInfo, share-token expiry). These are status-agnostic,
  // so the admin can correct them at any point in the lifecycle.
  const directUpdates: Record<string, unknown> = {};
  if (body.vehicleInfo !== undefined) directUpdates.vehicleInfo = body.vehicleInfo;
  if (body.validDays !== undefined) directUpdates.validDays = body.validDays;
  if (body.expiresAt !== undefined) {
    directUpdates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  }
  if (body.contact_name !== undefined) directUpdates.contactName = body.contact_name;
  if (body.contact_email !== undefined) directUpdates.contactEmail = body.contact_email;
  if (body.contact_phone !== undefined) directUpdates.contactPhone = body.contact_phone;
  if (body.contact_address !== undefined) directUpdates.contactAddress = body.contact_address;
  if (body.contact_preferred !== undefined) directUpdates.contactPreferred = body.contact_preferred;
  if (body.confirmedDiagnosis !== undefined) {
    directUpdates.confirmedDiagnosis = body.confirmedDiagnosis;
  }

  // Check for "nothing to change" BEFORE stamping updatedAt below — otherwise
  // directUpdates always has >=1 key by the time we'd check its length here.
  const hasDirectUpdates = Object.keys(directUpdates).length > 0;
  if (!wantsItemEdit && !hasDirectUpdates) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "No fields to update" } },
      400,
    );
  }

  if (hasDirectUpdates) {
    directUpdates.updatedAt = new Date();
    await db
      .update(schema.orders)
      .set(directUpdates)
      .where(and(eq(schema.orders.id, id), whereShop(schema.orders.shopId, shopId)));
  }

  // Return the freshly-read row so clients see the consistent post-write
  // state regardless of which branches ran.
  const [latest] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), whereShop(schema.orders.shopId, shopId)))
    .limit(1);
  if (!latest) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Loop closer: when the mechanic's confirmed diagnosis is recorded on a
  // fixo-linked order, report the outcome back to the brain. Fire-and-forget —
  // a calibration write must never block or fail the order save. No-op until an
  // order carries a fixo_prediction_id (set once HMLS routes through the brain).
  const diag = body.confirmedDiagnosis?.trim();
  if (diag && latest.fixoPredictionId) {
    recordOutcome({
      predictionId: latest.fixoPredictionId,
      confirmedDiagnosis: diag,
      actualCostCents: latest.paidAmountCents ?? latest.subtotalCents,
    }).catch((err) => {
      console.error(`recordOutcome failed for order ${id}:`, String(err));
    });
  }

  return c.json<OrderRow>(latest);
});

// POST /orders/:id/schedule — set / reschedule the appointment time.
// Routes through `attachSchedule` so the write is audited. Status never
// changes: approved + slot + mechanic IS the booked state, and the harness
// fires the customer's confirmation email once the pair completes.
orders.post("/:id/schedule", zValidator("json", scheduleOrderInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const body = c.req.valid("json");

  const when = new Date(body.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "scheduledAt is not a valid date" } },
      400,
    );
  }
  if (!Number.isInteger(body.durationMinutes) || body.durationMinutes <= 0) {
    return c.json<ApiError>(
      {
        error: {
          code: "BAD_REQUEST",
          message: "durationMinutes (positive integer) is required",
        },
      },
      400,
    );
  }

  const shopId = c.get("shopId");
  const authUser = c.get("authUser");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }
  const result = await attachSchedule(
    id,
    {
      scheduledAt: when,
      durationMinutes: body.durationMinutes,
      ...(body.location !== undefined ? { location: body.location } : {}),
    },
    adminActor(authUser.email),
  );
  if (!result.ok) return sendOrderStateResult(c, result);

  // Uber-style auto-dispatch when admin sets the time on an unassigned
  // order. Admin can still reassign manually from the order detail action panel.
  if (result.value.providerId == null) {
    await autoAssignProvider(id);
  }
  // Re-read so the response reflects the auto-assigned providerId.
  const [refreshed] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shopId, shopId)))
    .limit(1);
  return c.json<OrderRow>(refreshed ?? result.value);
});

// PATCH /orders/:id/status — generic status transition.
orders.patch("/:id/status", zValidator("json", transitionOrderInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const body = c.req.valid("json");
  // Already canonical — the zod contract maps legacy 'scheduled'/'revised'
  // inputs through canonicalizeStatus.
  const newStatus = body.status;
  const shopId = c.get("shopId");
  const authUser = c.get("authUser");

  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Drive-by adminNotes write — status-agnostic, so do it regardless of
  // transition outcome. Backfill shareToken for legacy orders while we're
  // here (pre-existing behavior kept for compatibility).
  if (body.notes) {
    await db
      .update(schema.orders)
      .set({ adminNotes: body.notes })
      .where(and(eq(schema.orders.id, id), eq(schema.orders.shopId, shopId)));
  }
  await backfillShareTokenIfMissing(id);

  const result = await transition(id, newStatus, adminActor(authUser.email), {
    reason: body.cancellationReason,
    // Customer-authorization evidence — required by the harness fence on
    // any →approved edge (including the draft→approved walk-in shortcut).
    authorization: body.authorization,
  });
  return sendOrderStateResult(c, result);
});

// POST /orders/:id/send — draft -> estimated (initial send or re-send after
// a revision pullback).
orders.post("/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }
  const authUser = c.get("authUser");
  await backfillShareTokenIfMissing(id);
  const result = await transition(id, "estimated", adminActor(authUser.email));
  return sendOrderStateResult(c, result);
});

// POST /orders/:id/revise — declined -> draft (re-open for revision; `revised`
// no longer exists — draft is the single shop-side WIP state). Route path kept
// for URL compat. revisionNumber is NOT bumped here; it is an
// optimistic-concurrency counter owned by patchItems, not a user-facing
// revision count.
orders.post("/:id/revise", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }
  const authUser = c.get("authUser");
  const result = await transition(id, "draft", adminActor(authUser.email));
  return sendOrderStateResult(c, result);
});

// GET /orders/:id/events — audit log for an order
orders.get("/:id/events", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const events = await db
    .select()
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.orderId, id))
    .orderBy(desc(schema.orderEvents.createdAt));

  return c.json<OrderEventRow[]>(events);
});

// POST /orders/:id/events — add an annotation note to an order. Scoped to
// note_added only; the harness owns structured events (status_change,
// items_edited, ...) so routes can't forge them.
orders.post("/:id/events", zValidator("json", addOrderNoteInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const body = c.req.valid("json");

  const authUser = c.get("authUser");
  const result = await addNote(id, body.note, adminActor(authUser.email));
  if (!result.ok) return sendOrderStateResult(c, result);
  return c.json<{ eventId: string }>(result.value, 201);
});

// POST /orders/:id/contact-log — record that staff manually reached out to
// the customer (called / texted / emailed). Audit-only, no state mutation;
// goes through the order-state harness like all structured events.
orders.post("/:id/contact-log", zValidator("json", logContactInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const body = c.req.valid("json");

  const authUser = c.get("authUser");
  const result = await logContact(id, body.method, adminActor(authUser.email), body.note);
  if (!result.ok) return sendOrderStateResult(c, result);
  return c.json<{ eventId: string }>(result.value, 201);
});

// POST /orders/:id/payment — stamp payment fields on an approved+ order.
// Payment is a property, not a lifecycle state.
orders.post("/:id/payment", zValidator("json", recordPaymentInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");
  if (!(await orderInShop(id, shopId))) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const body = c.req.valid("json");

  const authUser = c.get("authUser");
  const result = await recordPayment(id, {
    amountCents: body.amountCents,
    method: body.method,
    reference: body.reference ?? null,
    paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
  }, adminActor(authUser.email));
  return sendOrderStateResult(c, result);
});

// PATCH /orders/:id/notes — update admin notes
orders.patch("/:id/notes", zValidator("json", updateAdminNotesInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const body = c.req.valid("json");
  const shopId = c.get("shopId");

  const [updated] = await db
    .update(schema.orders)
    .set({ adminNotes: body.notes, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shopId, shopId)))
    .returning();

  if (!updated) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  return c.json<OrderRow>(updated);
});

// GET /orders/:id/pdf — admin-authenticated PDF (no token required; shop-scoped)
// Mounted under /api/admin/orders, so requireAdmin + requireShopContext are
// already applied by the orders router middleware above.
orders.get("/:id/pdf", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const shopId = c.get("shopId");

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      shopId === OWNER_ALL_SHOPS
        ? eq(schema.orders.id, id)
        : and(eq(schema.orders.id, id), eq(schema.orders.shopId, shopId)),
    )
    .limit(1);

  if (!order) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const customer = {
    name: order.contactName,
    phone: order.contactPhone,
    email: order.contactEmail,
    address: order.contactAddress,
    vehicleInfo: order.vehicleInfo as { make?: string; model?: string; year?: string } | null,
  };

  const items =
    ((order.items ?? []) as { name: string; description?: string; totalCents: number }[]).map(
      (i) => ({
        name: i.name,
        description: i.description ?? "",
        price: i.totalCents ?? 0,
      }),
    );

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

export { orders };

// Public order PDF route — token is REQUIRED; no token = 404.
// This is the unauthenticated, capability-based path shared in customer emails.
const ordersPdf = new Hono();

ordersPdf.get("/:id/pdf", zValidator("query", orderPdfQuery), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }

  const { token } = c.req.valid("query");

  // Require a non-empty token — id-only access is an IDOR (any caller can read
  // any order's PDF by guessing the numeric id). Token presence is the
  // capability proof that authorizes access to this specific order.
  if (!token) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // dbAdmin: this router has no requireShopContext/withTenantTx (mounted
  // standalone at /api/orders — see hmls-app.ts). A shareToken is a
  // capability, not a shop scope; the token-match WHERE clause below is the
  // authorization proof.
  const [order] = await dbAdmin
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, id), eq(schema.orders.shareToken, token)))
    .limit(1);

  if (!order) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  const customer = {
    name: order.contactName,
    phone: order.contactPhone,
    email: order.contactEmail,
    address: order.contactAddress,
    vehicleInfo: order.vehicleInfo as { make?: string; model?: string; year?: string } | null,
  };

  const items =
    ((order.items ?? []) as { name: string; description?: string; totalCents: number }[]).map(
      (i) => ({
        name: i.name,
        description: i.description ?? "",
        price: i.totalCents ?? 0,
      }),
    );

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

export { ordersPdf };
