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
import type { ContactMethod } from "@hmls/shared/api/contracts/orders";
import { notifyOrderStatusChange } from "../lib/notifications.ts";
import { hasIntakeFields, upsertOrderIntake } from "./order-intake.ts";
import {
  type Actor,
  type ActorKind,
  actorString,
  allowedTransitions,
  canActorTransition,
  canonicalizeStatus,
  EDITABLE_STATUSES,
  evaluateAuthorizationFence,
  isPaymentMethod,
  isTerminal,
  type OrderAuthorization,
  type OrderStatus,
  PAYMENT_ALLOWED_STATUSES,
  PAYMENT_METHODS,
  type PaymentMethod,
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
  canonicalizeStatus,
  hasBeenSentToCustomer,
  isPaymentMethod,
  isTerminal,
  type OrderAuthorization,
  type OrderStatus,
  PAYMENT_METHODS,
  type PaymentMethod,
  physicalStatusLabels,
  requiresCustomerAuthorization,
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

/** Fire a customer/admin email without blocking the caller. `templateKey` is
 *  either a canonical status or a schedule-event key ("schedule_ready" /
 *  "schedule_changed") — see notifications.ts. Errors are logged only —
 *  notification failures never roll back committed DB writes or surface as
 *  tool errors. */
function fireNotification(orderId: number, templateKey: string): void {
  notifyOrderStatusChange(orderId, templateKey).catch((err) => {
    logger.warn("notifyOrderStatusChange failed", {
      orderId,
      templateKey,
      err: String(err),
    });
  });
}

/** Slot + mechanic — the pair that makes an approved order a real booking. */
function schedulePairComplete(o: {
  scheduledAt: Date | null;
  providerId: number | null;
}): boolean {
  return o.scheduledAt != null && o.providerId != null;
}

type DbTx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Claim the once-per-order "appointment confirmed" notification inside `tx`.
 *  Inserts the schedule_ready_notified marker event; the partial unique index
 *  (migration 0043) allows at most one per order, and ON CONFLICT DO NOTHING
 *  makes concurrent pair-completions race-safe (C6). Returns true when this
 *  call won the insert — the caller sends the email after commit; false means
 *  someone already notified, skip sending. */
async function claimScheduleReadyNotification(
  tx: DbTx,
  orderId: number,
  actorStr: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.orderEvents)
    .values({
      orderId,
      eventType: "schedule_ready_notified" as const,
      actor: actorStr,
      metadata: {},
    })
    .onConflictDoNothing()
    .returning({ id: schema.orderEvents.id });
  return inserted.length > 0;
}

// ---------------------------------------------------------------------------
// transition — the only entry point for status changes
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Customer-authorization evidence. Required when the RESOLVED authority is
   *  shop-side (admin / staff agent) and the transition is fenced (any
   *  →approved edge, including the draft→approved walk-in shortcut).
   *  Customer / share-token authorities auto-inject `{ channel: "portal" }`
   *  — do not pass this for them. */
  authorization?: OrderAuthorization;
  /** Optimistic guard: require the row to still be in this CANONICAL status
   *  when the UPDATE fires. Defaults to the (canonicalized) status read from
   *  the DB. */
  expectedFrom?: OrderStatus;
  suppressNotification?: boolean;
}

export async function transition(
  orderId: number,
  to: OrderStatus,
  actor: Actor,
  options: TransitionOptions = {},
): Promise<OrderStateResult> {
  let target: OrderStatus;
  try {
    // Alias-tolerant input: legacy 'scheduled'/'revised' targets map to
    // canonical (deploy-window callers). Unknown strings are rejected.
    target = canonicalizeStatus(to as string);
  } catch {
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

  // Read-boundary canonicalization: rules run on the CANONICAL status even
  // when the physical row still carries a legacy label ('scheduled' /
  // 'revised' during the deploy→remap window). The optimistic-lock UPDATE
  // below guards on the RAW value — guarding on the canonical value would
  // never match a legacy row and the lock would conflict forever — and its
  // SET writes the canonical target, lazily converging the row.
  const rawStatus = current.status;
  const from = canonicalizeStatus(rawStatus);

  if (options.expectedFrom && options.expectedFrom !== from) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order status changed concurrently — refresh and retry" },
    };
  }

  if (isTerminal(from)) {
    return { ok: false, error: { code: "terminal_state", status: from as TerminalStatus } };
  }
  if (!allowedTransitions(from).includes(target)) {
    return { ok: false, error: { code: "invalid_transition", from, to: target } };
  }
  if (!canActorTransition(from, target, actor)) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        reason: `${actorString(actor)} cannot transition ${from}->${target}`,
      },
    };
  }

  // Start guard (C1): work cannot start without an assigned mechanic — the
  // explicit inheritance of the old machine's "scheduled implies mechanic"
  // invariant, enforced for EVERY actor. scheduledAt is deliberately not
  // required (a mobile mechanic starting an ad-hoc on-site job is legal).
  if (target === "in_progress" && current.providerId == null) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Cannot start work: no mechanic assigned. Assign a mechanic first.",
      },
    };
  }

  // Compliance fence: transitions that represent the customer's authorization
  // to proceed must carry evidence of HOW they authorized. Judged on the
  // resolved authority, so the staff agent is fenced exactly like the admin;
  // customer / share-token portal actions auto-inject their own evidence.
  const fence = evaluateAuthorizationFence(from, target, actor, options.authorization);
  if (!fence.ok) {
    return { ok: false, error: { code: "invalid_input", message: fence.message } };
  }

  const actorStr = actorString(actor);
  const now = new Date();
  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];

  const updateFields: Record<string, unknown> = {
    status: target,
    statusHistory: [
      ...history,
      { status: target, timestamp: now.toISOString(), actor: actorStr },
    ],
    updatedAt: now,
  };
  // `cancellationReason` is the generic "why did this flow stop" column.
  // Both cancelled and declined set it so the admin UI has a single field
  // to surface either way. For other transitions the reason is recorded in
  // order_events metadata only.
  if ((target === "cancelled" || target === "declined") && options.reason) {
    updateFields.cancellationReason = options.reason;
  }

  // Status-guarded UPDATE + event insert in one transaction. If either
  // fails the whole thing rolls back, keeping status and audit log in sync.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set(updateFields)
      // RAW-value guard — see the canonicalization comment above.
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, rawStatus)))
      .returning();

    if (!row) return null;

    await tx.insert(schema.orderEvents).values({
      orderId,
      eventType: "status_change",
      fromStatus: from,
      toStatus: target,
      actor: actorStr,
      metadata: {
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.metadata ?? {}),
        // Last spread wins — caller metadata cannot forge the evidence key.
        ...(fence.authorization
          ? {
            authorization: {
              channel: fence.authorization.channel,
              ...(fence.authorization.note?.trim()
                ? { note: fence.authorization.note.trim() }
                : {}),
              // Bind the evidence to the exact quote version being authorized
              // — captured from the row, never caller-supplied.
              revisionNumber: current.revisionNumber ?? 1,
              subtotalCents: current.subtotalCents ?? 0,
            },
          }
          : {}),
      },
    });

    // Approval landing on an already fully-scheduled order (slot + mechanic
    // both set): approved IS the booked state, so the customer's
    // "appointment confirmed" email fires now — deduped by the
    // schedule_ready marker so completions via attachSchedule /
    // assignProvider / this path send exactly once per order (C6).
    let scheduleReadyClaimed = false;
    if (target === "approved" && schedulePairComplete(row)) {
      scheduleReadyClaimed = await claimScheduleReadyNotification(tx, orderId, actorStr);
    }

    return { row, scheduleReadyClaimed };
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order status changed concurrently — refresh and retry" },
    };
  }

  if (!options.suppressNotification) {
    if (updated.scheduleReadyClaimed) {
      // Approval on an already-scheduled order: the "appointment confirmed"
      // email fully covers it. Skip the generic "approved — we'll schedule"
      // template, whose body promises a future confirmation email that would
      // land in the same batch and contradict this one (walk-in shortcut +
      // portal approval of a pre-scheduled estimate both hit this path).
      fireNotification(orderId, "schedule_ready");
    } else {
      fireNotification(orderId, target);
    }
  }

  return { ok: true, value: updated.row };
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
  contactPreferred?: ContactMethod | null;
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
  /** When true (default), editing items on an `estimated` order pulls it
   *  back to `draft` (revision in progress — see hasBeenSentToCustomer)
   *  and emits a status_change event. Pass false only for admin patches
   *  that intentionally preserve the 'estimated' state (e.g., fixing a
   *  typo without alarming the customer). */
  autoRevertEstimatedToDraft?: boolean;
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

  // Canonical for rules, raw for the optimistic-lock WHERE (a physical
  // legacy 'revised' row is editable as canonical 'draft' during the
  // deploy→remap window). approved / in_progress stay hard-blocked —
  // mid-job item additions need the supplemental-authorization flow (PR 7).
  const rawStatus = current.status;
  const from = canonicalizeStatus(rawStatus);
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

  const autoRevert = options.autoRevertEstimatedToDraft ?? true;
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
  if (patch.contactPreferred !== undefined) {
    updateFields.contactPreferred = patch.contactPreferred;
  }
  if (patch.location !== undefined) updateFields.location = patch.location;
  if (patch.locationLat !== undefined) updateFields.locationLat = patch.locationLat;
  if (patch.locationLng !== undefined) updateFields.locationLng = patch.locationLng;
  if (willRevert) {
    updateFields.status = "draft";
    updateFields.statusHistory = [
      ...history,
      { status: "draft", timestamp: now.toISOString(), actor: actorStr },
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
        // RAW status guard — see the canonicalization comment above.
        sql`${schema.orders.id} = ${orderId}
          AND ${schema.orders.status} = ${rawStatus}
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
        toStatus: "draft",
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
    // Pullback notice: admin-facing only ("estimate pulled back to draft") —
    // the customer hears nothing until the revised estimate is re-sent.
    fireNotification(orderId, "draft");
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
// Scheduling can be attached at any pre-terminal status (canonical). It is
// always a pure field update now — approved + scheduledAt + providerId IS
// the booked state; there is no status to advance to.
const SCHEDULE_ATTACH_FROM: ReadonlySet<OrderStatus> = new Set([
  "draft",
  "estimated",
  "approved",
  "in_progress",
]);

/** Attach scheduling fields. Status is never changed: for `draft` /
 *  `estimated` the slot is pre-committed alongside the in-flight estimate;
 *  for `approved` it completes (or reschedules) the booking; for
 *  `in_progress` it's a mid-job reschedule. When this write completes the
 *  slot+mechanic pair on an `approved` order it fires the customer's
 *  "appointment confirmed" email exactly once per order (schedule_ready
 *  marker, C6); a later time change sends a "time changed" email instead. */
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

  // Canonical for rules, raw for the status-guarded WHERE (window rows).
  const rawStatus = current.status;
  const from = canonicalizeStatus(rawStatus);
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
  const pairWasComplete = schedulePairComplete(current);
  const timeChanged = current.scheduledAt?.getTime() !== patch.scheduledAt.getTime();

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

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.orders)
      .set(updateFields)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.status, rawStatus)))
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

    // Slot+mechanic pair went incomplete → complete on an approved order:
    // claim the once-per-order confirmation email (C6).
    let scheduleReadyClaimed = false;
    if (from === "approved" && !pairWasComplete && schedulePairComplete(row)) {
      scheduleReadyClaimed = await claimScheduleReadyNotification(tx, orderId, actorStr);
    }

    return { row, scheduleReadyClaimed };
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order status changed concurrently" },
    };
  }

  if (updated.scheduleReadyClaimed) {
    fireNotification(orderId, "schedule_ready");
  } else if (
    from === "approved" && pairWasComplete && schedulePairComplete(updated.row) && timeChanged
  ) {
    // Reschedule of a confirmed booking — "time changed" email, no dedup.
    fireNotification(orderId, "schedule_changed");
  }

  return { ok: true, value: updated.row };
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

    // This assignment completed the slot+mechanic pair on an approved order
    // (slot was already set, mechanic was missing): claim the once-per-order
    // "appointment confirmed" email (C6). Reassignment (pair was already
    // complete) sends nothing — the customer never sees mechanic identity.
    let scheduleReadyClaimed = false;
    if (
      canonicalizeStatus(order.status) === "approved" &&
      order.scheduledAt != null && order.providerId == null
    ) {
      scheduleReadyClaimed = await claimScheduleReadyNotification(tx, orderId, actorStr);
    }

    return { row, scheduleReadyClaimed };
  });

  if (!updated) {
    return {
      ok: false,
      error: { code: "conflict", message: "Order was deleted concurrently" },
    };
  }

  if (updated.scheduleReadyClaimed) {
    fireNotification(orderId, "schedule_ready");
  }

  return { ok: true, value: updated.row };
}

// ---------------------------------------------------------------------------
// recordPayment — stamp payment fields (no status change)
// ---------------------------------------------------------------------------

export interface PaymentRecord {
  amountCents: number;
  method: PaymentMethod;
  reference?: string | null;
  paidAt?: Date;
}

// Mechanic: on-the-spot collection after completing their own job. The
// gateway route enforces ownership + completed-only; authority kind alone is
// checked here (same split as transition()).
const PAYMENT_WRITE_ACTORS: ReadonlySet<ActorKind> = new Set(["admin", "system", "mechanic"]);

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
  // explicitly so a misrouted webhook can't stamp bad data. Canonicalized:
  // a window-period physical 'scheduled' row is payable as 'approved'.
  const orderStatus = canonicalizeStatus(order.status);
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
        // Audit doesn't lie: a mechanic-collected payment names the collector
        // instead of being proxied through a system/admin actor.
        ...(authority.kind === "mechanic" ? { collectedBy: authority.providerId } : {}),
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

// ---------------------------------------------------------------------------
// logContact — manual-outreach audit entry, no state mutation
// ---------------------------------------------------------------------------

export async function logContact(
  orderId: number,
  method: ContactMethod,
  actor: Actor,
  note?: string,
): Promise<OrderStateResult<{ eventId: string }>> {
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
      eventType: "customer_contacted",
      actor: actorString(actor),
      metadata: { method, ...(note?.trim() ? { note: note.trim() } : {}) },
    })
    .returning({ id: schema.orderEvents.id });

  return { ok: true, value: { eventId: event.id } };
}
