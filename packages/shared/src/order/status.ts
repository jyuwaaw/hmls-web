// Pure core of the order state harness: types, state-machine tables,
// read helpers, actor resolution. Zero runtime dependencies — safe to
// import from any layer (web UI, auth middleware, gateway routes, agent
// tools, tests).
//
// DB-touching writes (transition, patchItems, ...) live in order-state.ts
// and build on this module.

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Seven lifecycle states. Payment is a property (paid_at), not a state.
 *  Scheduling is a property too (scheduled_at + provider_id on `approved`),
 *  and revision-in-progress is derived (`draft` + hasBeenSentToCustomer).
 *  The legacy `scheduled` / `revised` states were collapsed in the 9→7
 *  migration (0044) — see LegacyOrderStatus / canonicalizeStatus. */
export type OrderStatus =
  | "draft"
  | "estimated"
  | "approved"
  | "declined"
  | "in_progress"
  | "completed"
  | "cancelled";

/** Retired status labels that may still exist on physical rows during the
 *  deploy→remap window (and forever in order_events history / the PG enum,
 *  which keeps all labels — no type surgery). */
export type LegacyOrderStatus = "scheduled" | "revised";

/** What a DB row's status column can physically hold. */
export type PhysicalOrderStatus = OrderStatus | LegacyOrderStatus;

export type TerminalStatus = Extract<OrderStatus, "completed" | "cancelled">;

/** Who is causing the change. Tagged so the harness can permission-check
 *  and stamp a meaningful actor string on the audit event. Callers build
 *  this at the edge from their auth context. Never hardcode "agent".
 *
 *  `share_token` is the authority conferred by possession of the order's
 *  shareToken — used on the public /estimates/:id/approve|decline flow
 *  where the caller is not logged in but is demonstrably the recipient of
 *  the estimate link (often an anonymous / guest customer). */
export type Actor =
  | { kind: "customer"; customerId: number }
  | { kind: "admin"; email: string }
  | { kind: "mechanic"; providerId: number }
  | { kind: "agent"; surface: "customer_chat" | "staff_chat"; actingAs: Actor }
  | {
    kind: "system";
    source: "stripe_webhook" | "cron" | "migration" | "auto_dispatch";
  }
  | { kind: "share_token"; orderId: number };

export type ActorKind = Actor["kind"];

// ---------------------------------------------------------------------------
// Legacy-status canonicalization — the ONLY alias-tolerance point
// ---------------------------------------------------------------------------

const LEGACY_STATUS_ALIASES: Readonly<Record<LegacyOrderStatus, OrderStatus>> = {
  // scheduled = approved with the scheduling columns filled.
  scheduled: "approved",
  // revised = draft whose statusHistory contains 'estimated' (pullback).
  revised: "draft",
};

/** Map any raw status string (DB row, API input, tool input) to the
 *  canonical 7-state machine. Legacy `scheduled`→`approved` and
 *  `revised`→`draft`; canonical values pass through; anything else throws
 *  (an unknown status is data corruption, not something to paper over).
 *
 *  This function is the ONLY place legacy labels are tolerated. Do not add
 *  ad-hoc `=== "scheduled"` compatibility branches elsewhere. */
export function canonicalizeStatus(raw: string): OrderStatus {
  const alias = LEGACY_STATUS_ALIASES[raw as LegacyOrderStatus];
  if (alias) return alias;
  if (isOrderStatus(raw)) return raw;
  throw new Error(`Unknown order status '${raw}'`);
}

/** Physical DB labels that canonicalize to `canonical` — the canonical label
 *  plus any legacy aliases. Use in SQL status filters during the
 *  deploy→remap window so pre-remap rows (still labelled `scheduled` /
 *  `revised`) don't vanish from lists. After remap the legacy labels never
 *  match — keeping them is harmless. */
export function physicalStatusLabels(
  canonical: OrderStatus,
): readonly PhysicalOrderStatus[] {
  const legacy = (Object.keys(LEGACY_STATUS_ALIASES) as LegacyOrderStatus[])
    .filter((l) => LEGACY_STATUS_ALIASES[l] === canonical);
  return [canonical, ...legacy];
}

// ---------------------------------------------------------------------------
// State machine tables — single source of truth
// ---------------------------------------------------------------------------

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // `draft → approved` is the walk-in shortcut: the customer authorized the
  // work out-of-band (verbally / by text), so the shop confirms the draft
  // straight to approved — fenced by requiresCustomerAuthorization, so the
  // evidence (channel + note) is always recorded. `draft → estimated` is
  // the review-and-send path for portal approvals.
  draft: ["estimated", "approved", "cancelled"],
  // `estimated → draft` is the pullback: the shop edits a sent estimate,
  // which withdraws it from the customer until re-sent (driven by
  // patchItems' auto-revert, or explicitly).
  estimated: ["approved", "declined", "cancelled", "draft"],
  declined: ["draft", "cancelled"],
  // Scheduling no longer changes status — approved + scheduled_at +
  // provider_id IS the booked state. Starting work requires an assigned
  // provider (enforced in transition()).
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Per-actor transition allowlist. Missing (actor, from) or (actor, from, to)
 *  triples are rejected as FORBIDDEN even when the transition is valid in
 *  TRANSITIONS. `agent` has no entry of its own — authority resolves via
 *  `actingAs`. */
export const ACTOR_PERMISSIONS: Readonly<
  Record<
    Exclude<ActorKind, "agent">,
    Partial<Record<OrderStatus, readonly OrderStatus[]>>
  >
> = {
  customer: {
    // `draft` cancel: chat-flow draft accumulates items + appointment for
    // the customer; they can walk away before admin confirms.
    draft: ["cancelled"],
    estimated: ["approved", "declined", "cancelled"],
    // Customer can cancel an approved (possibly scheduled) order before
    // work starts. In-progress cancellation goes through the shop.
    approved: ["cancelled"],
  },
  admin: {
    draft: ["estimated", "approved", "cancelled"],
    estimated: ["approved", "declined", "cancelled", "draft"],
    declined: ["draft", "cancelled"],
    approved: ["in_progress", "cancelled"],
    in_progress: ["completed", "cancelled"],
  },
  mechanic: {
    approved: ["in_progress"],
    in_progress: ["completed"],
  },
  // System actors do not drive transitions today. Payment recording and
  // backfills are non-transition writes. Kept as an explicit empty map so
  // adding a system-driven transition later is a one-line change.
  system: {},
  // Share-token holders can respond to the estimate they were sent.
  // Narrower than customer — no approved-order cancel, since cancelling a
  // booked appointment needs real auth.
  share_token: {
    estimated: ["approved", "declined"],
  },
};

export const EDITABLE_STATUSES: ReadonlySet<OrderStatus> = new Set(
  ["draft", "estimated"],
);

/** Statuses on which a payment row can be stamped. Approved is included so
 *  shops that charge a deposit on approval work; draft / estimated /
 *  declined / cancelled reject recordPayment. */
export const PAYMENT_ALLOWED_STATUSES: ReadonlySet<OrderStatus> = new Set(
  ["approved", "in_progress", "completed"],
);

/** Manual payment methods a human can record. Single source of truth for the
 *  recordPayment harness, the API contract, and the web method selects. */
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

// ---------------------------------------------------------------------------
// Drift self-check (exercised by the L1 test suite)
// ---------------------------------------------------------------------------

/** Every (from, to) in TRANSITIONS must have at least one actor permitted
 *  in ACTOR_PERMISSIONS. A "ghost edge" (legal in the state machine but no
 *  actor can drive it) signals the two tables have drifted. */
export function _checkTransitionActorCoverage(): {
  orphans: Array<{ from: OrderStatus; to: OrderStatus }>;
} {
  const orphans: Array<{ from: OrderStatus; to: OrderStatus }> = [];
  for (const [fromKey, targets] of Object.entries(TRANSITIONS)) {
    const from = fromKey as OrderStatus;
    for (const to of targets) {
      const hasAny = Object.values(ACTOR_PERMISSIONS).some(
        (perms) => perms[from]?.includes(to) ?? false,
      );
      if (!hasAny) orphans.push({ from, to });
    }
  }
  return { orphans };
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for the write layer, not meant for UI / auth)
// ---------------------------------------------------------------------------

/** Walk an `agent` chain down to the underlying non-agent actor. Throws on
 *  pathological chains (types prevent this normally; guard catches unsafe
 *  casts). */
export function resolveAuthority(actor: Actor): Exclude<Actor, { kind: "agent" }> {
  let current: Actor = actor;
  let hops = 0;
  while (current.kind === "agent") {
    if (hops++ > 4) {
      throw new Error("Actor delegation chain too deep");
    }
    current = current.actingAs;
  }
  return current;
}

/** Short, stable actor string for order_events.actor. Examples:
 *  "customer:42", "admin:alice@shop.com", "mechanic:7",
 *  "agent(customer_chat)->customer:42", "system:stripe_webhook". */
export function actorString(actor: Actor): string {
  switch (actor.kind) {
    case "customer":
      return `customer:${actor.customerId}`;
    case "admin":
      return `admin:${actor.email}`;
    case "mechanic":
      return `mechanic:${actor.providerId}`;
    case "system":
      return `system:${actor.source}`;
    case "share_token":
      return `share_token:order${actor.orderId}`;
    case "agent":
      return `agent(${actor.surface})->${actorString(actor.actingAs)}`;
    default: {
      const _exhaustive: never = actor;
      throw new Error(`Unknown actor kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function isOrderStatus(s: string): s is OrderStatus {
  return s in TRANSITIONS;
}

// ---------------------------------------------------------------------------
// Compliance fence — customer-authorization evidence (CA BAR / BPC)
// ---------------------------------------------------------------------------

/** How the customer authorized the work. `portal` is auto-injected when the
 *  customer (or a share-token holder) acts directly — their portal action IS
 *  the evidence. Shop-driven transitions must say which out-of-band channel
 *  carried the approval. */
export const AUTHORIZATION_CHANNELS = ["portal", "text", "call", "in_person"] as const;
export type AuthorizationChannel = (typeof AUTHORIZATION_CHANNELS)[number];

export interface OrderAuthorization {
  channel: AuthorizationChannel;
  note?: string;
}

/** Fenced edges: any transition into `approved`. This now covers the walk-in
 *  shortcut too (draft→approved replaced the legacy draft→scheduled edge in
 *  the 9→7 collapse), so a single predicate fences every path into work
 *  authorization. */
export function requiresCustomerAuthorization(_from: OrderStatus, to: OrderStatus): boolean {
  return to === "approved";
}

export type AuthorizationFenceResult =
  | { ok: true; authorization?: OrderAuthorization }
  | { ok: false; message: string };

/** Resolve the evidence requirement for a transition. Judged on the RESOLVED
 *  authority — an agent acting for an admin is fenced exactly like the admin
 *  (never on actor.kind, or the staff agent would slip through). Customer /
 *  share-token authorities auto-inject `{ channel: "portal" }`; any provided
 *  evidence is ignored for them so a portal action can't claim another
 *  channel. When `ok` and `authorization` is set, the caller must persist it
 *  as audit evidence. */
export function evaluateAuthorizationFence(
  from: OrderStatus,
  to: OrderStatus,
  actor: Actor,
  provided?: OrderAuthorization,
): AuthorizationFenceResult {
  if (!requiresCustomerAuthorization(from, to)) return { ok: true };
  const authority = resolveAuthority(actor);
  if (authority.kind === "customer" || authority.kind === "share_token") {
    return { ok: true, authorization: { channel: "portal" } };
  }
  if (!provided) {
    return {
      ok: false,
      message: `Transition ${from}->${to} requires customer-authorization evidence ` +
        `(channel: ${AUTHORIZATION_CHANNELS.join("|")}, optional note)`,
    };
  }
  return { ok: true, authorization: provided };
}

// ---------------------------------------------------------------------------
// Read helpers — safe to import from any layer (UI, auth, middleware)
// ---------------------------------------------------------------------------

export function isTerminal(status: OrderStatus): status is TerminalStatus {
  return status === "completed" || status === "cancelled";
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canActorTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: Actor,
): boolean {
  if (!allowedTransitions(from).includes(to)) return false;
  const authority = resolveAuthority(actor);
  const perms = ACTOR_PERMISSIONS[authority.kind];
  return perms[from]?.includes(to) ?? false;
}

/** UI helper — the subset of allowed transitions this actor may currently
 *  drive. Used by admin dashboard + customer portal to render action
 *  buttons without hardcoding rules client-side. */
export function availableActions(
  from: OrderStatus,
  actor: Actor,
): readonly OrderStatus[] {
  const authority = resolveAuthority(actor);
  const perms = ACTOR_PERMISSIONS[authority.kind][from] ?? [];
  const allowed = allowedTransitions(from);
  return perms.filter((s) => allowed.includes(s));
}

/** True when an order is being completed without the mechanic's confirmed
 *  diagnosis. That (intake symptom → confirmed truth) pair is the labeled
 *  ground truth the diagnostic engine calibrates on. The web uses this to
 *  prompt for it at completion — a soft nudge, not a hard block: the mechanic
 *  can still proceed. Pure. */
export function completionMissingDiagnosis(
  to: OrderStatus,
  confirmedDiagnosis: string | null | undefined,
): boolean {
  return to === "completed" && !confirmedDiagnosis?.trim();
}

/** True iff the estimate has ever been sent to the customer — i.e. the
 *  order's statusHistory contains an `estimated` entry. This is THE
 *  predicate for draft dual-semantics: a draft that was sent is a
 *  "revision in progress" (share links say so, admin badge says "rev N"),
 *  a never-sent draft is a fresh AI draft awaiting review.
 *
 *  Reads ONLY the row-local statusHistory jsonb — never query order_events
 *  for this (the admin list would turn into a per-row N+1). Do not use
 *  revisionNumber: it defaults to 1 and increments on pure-draft edits, so
 *  it misfires on never-sent drafts. */
export function hasBeenSentToCustomer(order: {
  statusHistory: readonly { status: string }[] | null | undefined;
}): boolean {
  return Array.isArray(order.statusHistory) &&
    order.statusHistory.some((e) => e.status === "estimated");
}

// ---------------------------------------------------------------------------
// Step-progress helpers (consumed by web's progress bar)
// ---------------------------------------------------------------------------

/** Linear lifecycle steps (excludes the declined branch and terminal
 *  cancellation). Used to render a progress bar. */
export const ORDER_MAIN_STEPS = [
  "draft",
  "estimated",
  "approved",
  "in_progress",
  "completed",
] as const;

export const ORDER_TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "cancelled",
]);

export const ORDER_BRANCH_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "declined",
]);

export type OrderStepState = "completed" | "current" | "pending";

export function getOrderStepState(
  stepStatus: OrderStatus,
  currentStatus: OrderStatus,
): OrderStepState {
  const main = ORDER_MAIN_STEPS as readonly OrderStatus[];
  const currentIdx = main.indexOf(currentStatus);
  const stepIdx = main.indexOf(stepStatus);

  if (currentIdx === -1) {
    if (currentStatus === "declined") {
      const effectiveIdx = main.indexOf("estimated");
      return stepIdx <= effectiveIdx ? "completed" : "pending";
    }
    return stepIdx === 0 ? "completed" : "pending";
  }

  if (stepIdx < currentIdx) return "completed";
  if (stepIdx === currentIdx) return "current";
  return "pending";
}
