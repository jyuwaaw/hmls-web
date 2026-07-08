// Order state harness — the ONLY module allowed to mutate order lifecycle
// fields (status, statusHistory), insert order_events, or fire status-change
// notifications. Every surface (gateway admin routes, customer portal,
// mechanic app, customer/staff chat agents, Stripe webhook) must funnel
// through this module. Do NOT bypass.
//
// Pure state-machine rules, types, and read helpers live in
// `@hmls/shared/order/status` and are re-exported from here — UI and auth
// layers should import from shared directly to avoid pulling in the DB
// client.
//
// Invariants (enforced by the implementations below):
//   1. Every status mutation goes through `transition` — or through a
//      sibling write (e.g. patchItems) that emits the same audit trail.
//   2. `statusHistory` is append-only.
//   3. Every successful status mutation inserts exactly one order_events
//      row with eventType="status_change".
//   4. `notifyOrderStatusChange` fires iff the DB update succeeded and
//      `suppressNotification` is unset.
//   5. All DB writes use a status-guarded WHERE clause — concurrent writers
//      get `conflict`, never silent overwrite.
//   6. UPDATE + order_events INSERT are wrapped in a single transaction so
//      a failed event insert rolls back the status change.
//   7. `ACTOR_PERMISSIONS` is checked before any DB mutation.
//   8. `Actor` of kind "agent" has no standalone authority — it resolves
//      via `actingAs`.

import { and, eq, sql } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { db, dbAdmin, schema } from "../db/client.ts";
import type { OrderItem } from "@hmls/shared/db/schema";
import { notifyOrderStatusChange } from "../lib/notifications.ts";
import { hasIntakeFields, upsertOrderIntake } from "./order-intake.ts";
import {
  type Actor,
  type ActorKind,
  actorString,
  allowedTransitions,
  canActorTransition,
  EDITABLE_STATUSES,
  isOrderStatus,
  isTerminal,
  type OrderStatus,
  PAYMENT_ALLOWED_STATUSES,
  resolveAuthority,
  type TerminalStatus,
} from "@hmls/shared/order/status";

const logger = getLogger(["hmls", "agent", "order-state"]);

// Re-export the pure core so callers can `import { transition, availableActions,
// TRANSITIONS } from "./order-state.ts"` without reaching into core.
export {
  _checkTransitionActorCoverage,
  type Actor,
  ACTOR_PERMISSIONS,
  type ActorKind,
  allowedTransitions,
  availableActions,
  canActorTransition,
  isTerminal,
  type OrderStatus,
  type TerminalStatus,
  TRANSITIONS,
} from "@hmls/shared/order/status";

export type OrderRow = typeof schema.orders.$inferSelect;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type OrderStateError =
  | { code: "not_found"; orderId: number }
  | { code: "invalid_transition"; from: OrderStatus; to: OrderStatus }
  | { code: "forbidden"; reason: string }
  | { code: "conflict"; message: string }
  | { code: "terminal_state"; status: TerminalStatus }
  | { code: "not_editable"; status: OrderStatus }
  | { code: "invalid_input"; message: string };

export type OrderStateResult<T = OrderRow> =
  | { ok: true; value: T }
  | { ok: false; error: OrderStateError };

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Fire status-change notification without blocking the caller. Errors are
 *  logged only — notification failures never roll back committed DB writes
 *  or surface as tool errors. */
function fireNotification(orderId: number, to: OrderStatus): void {
  notifyOrderStatusChange(orderId, to).catch((err) => {
    logger.warn("notifyOrderStatusChange failed", { orderId, to, err: String(err) });
  });
}

// ---------------------------------------------------------------------------
// transition — the only entry point for status changes
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Optimistic guard: require the row to still be in this status when the
   *  UPDATE fires. Defaults to the status read from the DB. */
  expectedFrom?: OrderStatus;
  suppressNotification?: boolean;
}

export async function transition(
  orderId: number,
  to: OrderStatus,
  actor: Actor,
  options: TransitionOptions = {},
): Promise<OrderStateResult> {
  if (!isOrderStatus(to)) {
    return { ok: false, error: { code: "invalid_input", message: `Unknown status '${to}'` } };
  }

  const [current] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!current) {
    return { ok: false, error: { code: "not_found", orderId } };
  }

  const from = current.status as OrderStatus;
  const expectedFrom = options.expectedFrom ?? from;

  if (isTerminal(from)) {
    return { ok: false, error: { code: "terminal_state", status: from as TerminalStatus } };
  }
  if (!allowedTransitions(from).includes(to)) {
    return { ok: false, error: { code: "invalid_transition", from, to } };
  }
  if (!canActorTransition(from, to, actor)) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason: `${actorString(actor)} cannot transition ${from}->${to}`,
      },
    };
  }

  const actorStr = actorString(actor);
  const now = new Date();
  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];

  const updateFields: Record<string, unknown> = {
    status: to,
    statusHistory: [
      ...history,
      { status: to, timestamp: now.toISOString(), actor: actorStr },
    ],
    updatedAt: now,
  };
  // `cancellationReason` is the generic "why did this flow stop" column.
  // Both cancelled and declined set it so the admin UI has a single field
  // to surface either way. For other transitions the reason is recorded in
  // order_events metadata only.
  if ((to === "cancelled" || to === "declined") && options.reason) {
    updateFields.cancellationReason = options.reason;
  }

  // Status-guarded UPDATE + event insert in one transaction. If either
  // fails the whole thing rolls back, keeping status and audit log in sync.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set(updateFields)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, expectedFrom)))
      .returning();

    if (!row) return null;

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "status_change",
      fromStatus: from,
      toStatus: to,
      actor: actorStr,
      metadata: {
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.metadata ?? {}),
      },
    });

    return row;
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order status changed concurrently — refresh and retry" },
    };
  }

  if (!options.suppressNotification) {
    fireNotification(orderId, to);
  }

  return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// patchItems — the only entry point for items / pricing / notes writes
// ---------------------------------------------------------------------------

export interface ItemsPatch {
  /** Replacement items array. Harness recomputes subtotal + price range
   *  from items.reduce() unless `subtotalCentsOverride` is provided.
   *  Pricing decisions (labor lookup, fees, discounts) are the caller's
   *  responsibility. */
  items: OrderItem[];
  notes?: string | null;
  /** Optional vehicle metadata update. vehicleInfo is not a lifecycle
   *  field but is commonly rewritten alongside items when an agent
   *  re-prices a quote for a corrected vehicle. Merged into the existing
   *  vehicleInfo shallowly. */
  vehicleInfo?: Record<string, unknown> | null;
  /** Mobile-mechanic access notes (gate code, parking, etc.). Pass
   *  `undefined` to leave unchanged, `null` to clear, a string to set. */
  accessInstructions?: string | null;
  /** Customer's symptom narrative for repair/diagnostic services. Same
   *  null/undefined semantics as accessInstructions. */
  symptomDescription?: string | null;
  /** Per-order contact snapshot updates. Used when an agent revises an
   *  order with corrected phone or service address — the snapshot on the
   *  order row needs to follow, not just the customers profile. Same
   *  null/undefined semantics as the fields above. */
  contactPhone?: string | null;
  contactAddress?: string | null;
  /** Booking/scheduling display location + coords. Re-geocoded by the
   *  caller when contactAddress changes on a revise, so the map pin never
   *  goes stale vs. the address the order now claims. */
  location?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
}

export interface PatchItemsOptions {
  /** Optimistic concurrency — must match current revisionNumber. */
  expectedVersion?: number;
  /** When true (default), editing items on an `estimated` order flips it
   *  back to `revised` and emits a status_change event. Pass false only
   *  for admin patches that intentionally preserve the 'estimated' state
   *  (e.g., fixing a typo in adminNotes without alarming the customer). */
  autoRevertEstimatedToRevised?: boolean;
  /** Audit metadata. */
  metadata?: Record<string, unknown>;
  /** Bypass the items.reduce() subtotal recomputation. Use this when the
   *  caller's pricing engine applies a floor (minimum service fee) or
   *  ceiling that items alone don't capture. Price range is derived from
   *  the override (0.9x .. 1.1x). */
  subtotalCentsOverride?: number;
}

const ITEM_EDIT_ACTORS: ReadonlySet<ActorKind> = new Set(["customer", "admin"]);

export async function patchItems(
  orderId: number,
  patch: ItemsPatch,
  actor: Actor,
  options: PatchItemsOptions = {},
): Promise<OrderStateResult> {
  const authority = resolveAuthority(actor);
  if (!ITEM_EDIT_ACTORS.has(authority.kind)) {
    return {
      ok: false,
      error: { code: "forbidden", reason: `${authority.kind} cannot edit items` },
    };
  }

  const [current] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!current) {
    return { ok: false, error: { code: "not_found", orderId } };
  }

  const from = current.status as OrderStatus;
  if (!EDITABLE_STATUSES.has(from)) {
    return { ok: false, error: { code: "not_editable", status: from } };
  }

  const currentVersion = current.revisionNumber ?? 1;
  if (options.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `Version mismatch: expected ${options.expectedVersion}, got ${currentVersion}`,
      },
    };
  }

  const subtotalCents = options.subtotalCentsOverride ??
    patch.items.reduce((sum, i) => sum + i.totalCents, 0);
  const actorStr = actorString(actor);
  const now = new Date();

  const autoRevert = options.autoRevertEstimatedToRevised ?? true;
  const willRevert = autoRevert && from === "estimated";

  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
  const updateFields: Record<string, unknown> = {
    items: patch.items,
    subtotalCents,
    priceRangeLowCents: Math.round(subtotalCents * 0.9),
    priceRangeHighCents: Math.round(subtotalCents * 1.1),
    revisionNumber: currentVersion + 1,
    updatedAt: now,
  };
  if (patch.notes !== undefined) updateFields.notes = patch.notes;
  if (patch.vehicleInfo !== undefined) {
    // Shallow merge so callers can patch individual fields without nuking
    // others. Pass `null` explicitly to clear.
    if (patch.vehicleInfo === null) {
      updateFields.vehicleInfo = null;
    } else {
      const existing = (current.vehicleInfo ?? {}) as Record<string, unknown>;
      updateFields.vehicleInfo = { ...existing, ...patch.vehicleInfo };
    }
  }
  if (patch.accessInstructions !== undefined) {
    updateFields.accessInstructions = patch.accessInstructions;
  }
  if (patch.contactPhone !== undefined) {
    updateFields.contactPhone = patch.contactPhone;
  }
  if (patch.contactAddress !== undefined) {
    updateFields.contactAddress = patch.contactAddress;
  }
  if (patch.location !== undefined) updateFields.location = patch.location;
  if (patch.locationLat !== undefined) updateFields.locationLat = patch.locationLat;
  if (patch.locationLng !== undefined) updateFields.locationLng = patch.locationLng;
  if (willRevert) {
    updateFields.status = "revised";
    updateFields.statusHistory = [
      ...history,
      { status: "revised", timestamp: now.toISOString(), actor: actorStr },
    ];
  }

  // symptomDescription is now on order_intake — route through the helper
  // inside the same transaction.
  const intakePatch = { symptomDescription: patch.symptomDescription };

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set(updateFields)
      .where(
        sql`${schema.orders.id} = ${orderId}
          AND ${schema.orders.status} = ${from}
          AND COALESCE(${schema.orders.revisionNumber}, 1) = ${currentVersion}`,
      )
      .returning();

    if (!row) return null;

    if (hasIntakeFields(intakePatch)) {
      await upsertOrderIntake(orderId, intakePatch, tx);
    }

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "items_edited",
      actor: actorStr,
      metadata: {
        itemCount: patch.items.length,
        newVersion: currentVersion + 1,
        ...(willRevert ? { revertedFromEstimated: true } : {}),
        ...(options.metadata ?? {}),
      },
    });

    if (willRevert) {
      await tx.insert(schema.orderEvents).values({
        orderId,
        eventType: "status_change",
        fromStatus: "estimated",
        toStatus: "revised",
        actor: actorStr,
        metadata: { reason: "items_edited_on_estimated_order" },
      });
    }

    return row;
  });

  if (!updated) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: "Order was modified concurrently (status or revisionNumber changed)",
      },
    };
  }

  if (willRevert) {
    fireNotification(orderId, "revised");
  }

  return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// attachSchedule — the only entry point for scheduling-field writes
// ---------------------------------------------------------------------------

export interface SchedulePatch {
  scheduledAt: Date;
  durationMinutes: number;
  providerId?: number | null;
  location?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  accessInstructions?: string | null;
  symptomDescription?: string | null;
  photoUrls?: string[] | null;
  customerNotes?: string | null;
}

const SCHEDULE_WRITE_ACTORS: ReadonlySet<ActorKind> = new Set(["customer", "admin"]);
// Scheduling can be attached at any pre-terminal status. Only `approved`
// advances to `scheduled`; the rest are pure field updates (pre-approval
// slot reservation, reschedule, reassign).
const SCHEDULE_ATTACH_FROM: ReadonlySet<OrderStatus> = new Set([
  "draft",
  "estimated",
  "revised",
  "approved",
  "scheduled",
  "in_progress",
]);

/** Attach scheduling fields. If the order is `approved`, also advances it
 *  to `scheduled` (single transition, follows the same discipline as
 *  `transition`). For orders in `draft` / `estimated` / `revised`,
 *  scheduling is pre-committed alongside the in-flight estimate — status
 *  is preserved and only a `schedule_attached` event is emitted. For
 *  `scheduled` / `in_progress`, this is a pure field update (reschedule
 *  / reassign location). */
export async function attachSchedule(
  orderId: number,
  patch: SchedulePatch,
  actor: Actor,
): Promise<OrderStateResult> {
  const authority = resolveAuthority(actor);
  if (!SCHEDULE_WRITE_ACTORS.has(authority.kind)) {
    return {
      ok: false,
      error: { code: "forbidden", reason: `${authority.kind} cannot attach scheduling` },
    };
  }

  const [current] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!current) {
    return { ok: false, error: { code: "not_found", orderId } };
  }

  const from = current.status as OrderStatus;
  if (!SCHEDULE_ATTACH_FROM.has(from)) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason: `Cannot attach schedule to order in '${from}' status`,
      },
    };
  }

  const actorStr = actorString(actor);
  const now = new Date();
  const willAdvance = from === "approved";
  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];

  const updateFields: Record<string, unknown> = {
    scheduledAt: patch.scheduledAt,
    durationMinutes: patch.durationMinutes,
    updatedAt: now,
  };
  if (patch.providerId !== undefined) updateFields.providerId = patch.providerId;
  if (patch.location !== undefined) updateFields.location = patch.location;
  if (patch.locationLat !== undefined) updateFields.locationLat = patch.locationLat;
  if (patch.locationLng !== undefined) updateFields.locationLng = patch.locationLng;
  if (patch.accessInstructions !== undefined) {
    updateFields.accessInstructions = patch.accessInstructions;
  }

  // Intake fields (symptomDescription / photoUrls / customerNotes) now live
  // on order_intake — collect them for a transactional upsert below.
  const intakePatch = {
    symptomDescription: patch.symptomDescription,
    photoUrls: patch.photoUrls,
    customerNotes: patch.customerNotes,
  };

  if (willAdvance) {
    updateFields.status = "scheduled";
    updateFields.statusHistory = [
      ...history,
      { status: "scheduled", timestamp: now.toISOString(), actor: actorStr },
    ];
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set(updateFields)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, from)))
      .returning();

    if (!row) return null;

    if (hasIntakeFields(intakePatch)) {
      await upsertOrderIntake(orderId, intakePatch, tx);
    }

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "schedule_attached",
      actor: actorStr,
      metadata: {
        scheduledAt: patch.scheduledAt.toISOString(),
        durationMinutes: patch.durationMinutes,
        providerId: patch.providerId ?? null,
      },
    });

    if (willAdvance) {
      await tx.insert(schema.orderEvents).values({
        orderId,
        eventType: "status_change",
        fromStatus: "approved",
        toStatus: "scheduled",
        actor: actorStr,
        metadata: { reason: "schedule_attached" },
      });
    }

    return row;
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order status changed concurrently" },
    };
  }

  if (willAdvance) {
    fireNotification(orderId, "scheduled");
  }

  return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// assignProvider — mechanic assignment (no status change)
// ---------------------------------------------------------------------------

export interface AssignProviderOptions {
  /** Allow assigning an inactive provider (admin override). */
  force?: boolean;
}

export async function assignProvider(
  orderId: number,
  providerId: number,
  actor: Actor,
  options: AssignProviderOptions = {},
): Promise<OrderStateResult> {
  const authority = resolveAuthority(actor);
  // Admin (manual dispatch) and system (auto-dispatch on customer schedule)
  // are the only authorities that can write providerId.
  if (authority.kind !== "admin" && authority.kind !== "system") {
    return {
      ok: false,
      error: { code: "forbidden", reason: `${authority.kind} cannot assign providers` },
    };
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return { ok: false, error: { code: "not_found", orderId } };
  }
  if (order.providerId === providerId) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Order already assigned to that mechanic" },
    };
  }

  // dbAdmin: assignProvider is invoked from a customer-scoped tx (auto-
  // dispatch on customer self-scheduling — see auto-assign.ts) as well as
  // admin. A customer-scoped tx sets only app.customer_id, so the shop-only
  // providers RLS policy would deny this read entirely. The shop boundary
  // is enforced explicitly by the shopId comparison below, not by RLS.
  const [provider] = await dbAdmin
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, providerId))
    .limit(1);

  if (!provider) {
    return { ok: false, error: { code: "not_found", orderId: providerId } };
  }
  if (provider.shopId !== order.shopId) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason:
          `Provider ${providerId} belongs to a different shop and cannot be assigned to this order`,
      },
    };
  }
  if (!provider.isActive && !options.force) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason: "Target mechanic is inactive. Pass force:true to assign anyway.",
      },
    };
  }

  const actorStr = actorString(actor);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set({ providerId, updatedAt: new Date() })
      .where(eq(schema.orders.id, orderId))
      .returning();

    if (!row) return null;

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "provider_assigned",
      actor: actorStr,
      metadata: {
        providerId,
        providerName: provider.name,
        previousProviderId: order.providerId ?? null,
      },
    });

    return row;
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order was deleted concurrently" },
    };
  }

  return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// recordPayment — stamp payment fields (no status change)
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "cash",
  "card",
  "check",
  "venmo",
  "zelle",
  "stripe",
  "other",
] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

const PAYMENT_METHOD_SET: ReadonlySet<string> = new Set(PAYMENT_METHODS);

export function isPaymentMethod(s: string): s is PaymentMethod {
  return PAYMENT_METHOD_SET.has(s);
}

export interface PaymentRecord {
  amountCents: number;
  method: PaymentMethod;
  reference?: string | null;
  paidAt?: Date;
}

const PAYMENT_WRITE_ACTORS: ReadonlySet<ActorKind> = new Set(["admin", "system"]);

export async function recordPayment(
  orderId: number,
  payment: PaymentRecord,
  actor: Actor,
): Promise<OrderStateResult> {
  const authority = resolveAuthority(actor);
  if (!PAYMENT_WRITE_ACTORS.has(authority.kind)) {
    return {
      ok: false,
      error: { code: "forbidden", reason: `${authority.kind} cannot record payments` },
    };
  }
  if (!Number.isFinite(payment.amountCents) || payment.amountCents <= 0) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "amountCents must be a positive number" },
    };
  }
  if (!payment.method || !isPaymentMethod(payment.method)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `method must be one of: ${PAYMENT_METHODS.join(", ")}`,
      },
    };
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return { ok: false, error: { code: "not_found", orderId } };
  }

  // Payment on cancelled / declined / draft orders is nonsensical — gate
  // explicitly so a misrouted webhook can't stamp bad data.
  const orderStatus = order.status as OrderStatus;
  if (!PAYMENT_ALLOWED_STATUSES.has(orderStatus)) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason: `Cannot record payment on order in '${orderStatus}' status`,
      },
    };
  }

  const actorStr = actorString(actor);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set({
        paidAt: payment.paidAt ?? new Date(),
        paymentMethod: payment.method,
        paymentReference: payment.reference ?? null,
        paidAmountCents: payment.amountCents,
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    if (!row) return null;

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "payment_recorded",
      actor: actorStr,
      metadata: {
        amountCents: payment.amountCents,
        method: payment.method,
        reference: payment.reference ?? null,
      },
    });

    return row;
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order was deleted concurrently" },
    };
  }

  return { ok: true, value: updated };
}

// ---------------------------------------------------------------------------
// addNote — free-text audit entry, no state mutation
// ---------------------------------------------------------------------------

export async function addNote(
  orderId: number,
  note: string,
  actor: Actor,
): Promise<OrderStateResult<{ eventId: string }>> {
  if (!note.trim()) {
    return { ok: false, error: { code: "invalid_input", message: "note is empty" } };
  }

  const [order] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return { ok: false, error: { code: "not_found", orderId } };
  }

  const [event] = await db
    .insert(schema.orderEvents)
    .values({
      orderId,
      eventType: "note_added",
      actor: actorString(actor),
      metadata: { note },
    })
    .returning({ id: schema.orderEvents.id });

  return { ok: true, value: { eventId: event.id } };
}
