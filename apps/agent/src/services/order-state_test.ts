// L1 pure tests for the order-state harness (7-state machine).
//
// Covers the read helpers, the state-machine table shape, the actor
// permission map, and the resolveAuthority / actorString internals. No DB.
//
// L2 tests (real DB, transaction atomicity, concurrency, the legacy-label
// window cases) live in a separate file so this suite stays fast and
// zero-dependency.

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  _checkTransitionActorCoverage,
  type Actor,
  ACTOR_PERMISSIONS,
  allowedTransitions,
  availableActions,
  canActorTransition,
  evaluateAuthorizationFence,
  isTerminal,
  type OrderStatus,
  requiresCustomerAuthorization,
  TRANSITIONS,
} from "@hmls/shared/order/status";

const ALL_STATUSES: readonly OrderStatus[] = [
  "draft",
  "estimated",
  "approved",
  "declined",
  "in_progress",
  "completed",
  "cancelled",
];

const CUSTOMER: Actor = { kind: "customer", customerId: 42 };
const ADMIN: Actor = { kind: "admin", email: "alice@shop.com" };
const MECHANIC: Actor = { kind: "mechanic", providerId: 7 };
const SYSTEM: Actor = { kind: "system", source: "stripe_webhook" };
const SHARE_TOKEN: Actor = { kind: "share_token", orderId: 99 };

// ---------------------------------------------------------------------------
// Consistency: TRANSITIONS and ACTOR_PERMISSIONS must not drift
// ---------------------------------------------------------------------------

Deno.test("consistency: every TRANSITIONS edge has at least one actor permitted", () => {
  const { orphans } = _checkTransitionActorCoverage();
  assertEquals(
    orphans,
    [],
    `Ghost edges detected (transitions with no actor): ${JSON.stringify(orphans)}`,
  );
});

Deno.test("consistency: ACTOR_PERMISSIONS never permits an edge outside TRANSITIONS", () => {
  const violations: Array<{ actor: string; from: string; to: string }> = [];
  for (const [actorKind, perms] of Object.entries(ACTOR_PERMISSIONS)) {
    for (const [fromKey, targets] of Object.entries(perms)) {
      const from = fromKey as OrderStatus;
      const allowed = TRANSITIONS[from] ?? [];
      for (const to of targets ?? []) {
        if (!allowed.includes(to)) {
          violations.push({ actor: actorKind, from, to });
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `Actor permissions reference non-existent transitions: ${JSON.stringify(violations)}`,
  );
});

Deno.test("consistency: TRANSITIONS has exactly the 7 canonical states", () => {
  assertEquals(
    Object.keys(TRANSITIONS).sort(),
    [...ALL_STATUSES].sort(),
    "TRANSITIONS keys must be the canonical 7-state set (no scheduled/revised)",
  );
});

// ---------------------------------------------------------------------------
// isTerminal
// ---------------------------------------------------------------------------

Deno.test("isTerminal: completed + cancelled are terminal, others are not", () => {
  for (const s of ALL_STATUSES) {
    const expected = s === "completed" || s === "cancelled";
    assertEquals(isTerminal(s), expected, `isTerminal(${s})`);
  }
});

Deno.test("isTerminal: terminal statuses have no outbound transitions", () => {
  for (const s of ALL_STATUSES) {
    if (isTerminal(s)) {
      assertEquals(TRANSITIONS[s], [], `terminal ${s} should have empty transitions`);
    }
  }
});

// ---------------------------------------------------------------------------
// allowedTransitions — shape of the 7-state machine
// ---------------------------------------------------------------------------

Deno.test("allowedTransitions: draft goes to estimated, approved (walk-in) or cancelled", () => {
  assertEquals(
    [...allowedTransitions("draft")].sort(),
    ["approved", "cancelled", "estimated"],
  );
});

Deno.test("allowedTransitions: estimated goes to approved/declined/cancelled + draft pullback", () => {
  assertEquals(
    [...allowedTransitions("estimated")].sort(),
    ["approved", "cancelled", "declined", "draft"],
  );
});

Deno.test("allowedTransitions: declined re-enters via draft or cancels", () => {
  assertEquals([...allowedTransitions("declined")].sort(), ["cancelled", "draft"]);
});

Deno.test("allowedTransitions: approved starts work or cancels (no scheduled state)", () => {
  assertEquals([...allowedTransitions("approved")].sort(), ["cancelled", "in_progress"]);
});

Deno.test("allowedTransitions: in_progress -> completed or cancelled", () => {
  assertEquals(
    [...allowedTransitions("in_progress")].sort(),
    ["cancelled", "completed"],
  );
});

// ---------------------------------------------------------------------------
// canActorTransition — representative cases across actor kinds
// ---------------------------------------------------------------------------

Deno.test("canActorTransition: customer can approve estimated", () => {
  assertStrictEquals(canActorTransition("estimated", "approved", CUSTOMER), true);
});

Deno.test("canActorTransition: customer can decline estimated", () => {
  assertStrictEquals(canActorTransition("estimated", "declined", CUSTOMER), true);
});

Deno.test("canActorTransition: customer can cancel approved (booked) order", () => {
  assertStrictEquals(canActorTransition("approved", "cancelled", CUSTOMER), true);
});

Deno.test("canActorTransition: customer CANNOT send draft -> estimated (shop-only)", () => {
  assertStrictEquals(canActorTransition("draft", "estimated", CUSTOMER), false);
});

Deno.test("canActorTransition: customer CANNOT drive draft -> approved (walk-in is shop-side)", () => {
  assertStrictEquals(canActorTransition("draft", "approved", CUSTOMER), false);
});

Deno.test("canActorTransition: customer CANNOT start work", () => {
  assertStrictEquals(canActorTransition("approved", "in_progress", CUSTOMER), false);
});

Deno.test("canActorTransition: customer CANNOT cancel in_progress (must contact shop)", () => {
  assertStrictEquals(canActorTransition("in_progress", "cancelled", CUSTOMER), false);
});

Deno.test("canActorTransition: customer CANNOT pull back estimated -> draft (shop-side edit)", () => {
  assertStrictEquals(canActorTransition("estimated", "draft", CUSTOMER), false);
});

Deno.test("canActorTransition: admin can send draft -> estimated", () => {
  assertStrictEquals(canActorTransition("draft", "estimated", ADMIN), true);
});

Deno.test("canActorTransition: admin can drive the walk-in shortcut draft -> approved", () => {
  assertStrictEquals(canActorTransition("draft", "approved", ADMIN), true);
});

Deno.test("canActorTransition: admin can pull back estimated -> draft", () => {
  assertStrictEquals(canActorTransition("estimated", "draft", ADMIN), true);
});

Deno.test("canActorTransition: admin can revise declined -> draft", () => {
  assertStrictEquals(canActorTransition("declined", "draft", ADMIN), true);
});

Deno.test("canActorTransition: admin can cancel from any active state", () => {
  const active: OrderStatus[] = [
    "draft",
    "estimated",
    "declined",
    "approved",
    "in_progress",
  ];
  for (const from of active) {
    assertStrictEquals(
      canActorTransition(from, "cancelled", ADMIN),
      true,
      `admin should cancel from ${from}`,
    );
  }
});

Deno.test("canActorTransition: mechanic can start approved work", () => {
  assertStrictEquals(canActorTransition("approved", "in_progress", MECHANIC), true);
});

Deno.test("canActorTransition: mechanic can complete in_progress work", () => {
  assertStrictEquals(canActorTransition("in_progress", "completed", MECHANIC), true);
});

Deno.test("canActorTransition: mechanic CANNOT approve estimated (not their role)", () => {
  assertStrictEquals(canActorTransition("estimated", "approved", MECHANIC), false);
});

Deno.test("canActorTransition: mechanic CANNOT cancel (escalate to admin)", () => {
  assertStrictEquals(canActorTransition("approved", "cancelled", MECHANIC), false);
  assertStrictEquals(canActorTransition("in_progress", "cancelled", MECHANIC), false);
});

Deno.test("canActorTransition: system drives no transitions by default", () => {
  for (const from of ALL_STATUSES) {
    for (const to of allowedTransitions(from)) {
      assertStrictEquals(
        canActorTransition(from, to, SYSTEM),
        false,
        `system should not drive ${from}->${to}`,
      );
    }
  }
});

Deno.test("canActorTransition: share_token approves estimated", () => {
  assertStrictEquals(canActorTransition("estimated", "approved", SHARE_TOKEN), true);
});

Deno.test("canActorTransition: share_token declines estimated", () => {
  assertStrictEquals(canActorTransition("estimated", "declined", SHARE_TOKEN), true);
});

Deno.test("canActorTransition: share_token CANNOT cancel approved (needs real auth)", () => {
  assertStrictEquals(canActorTransition("approved", "cancelled", SHARE_TOKEN), false);
});

Deno.test("canActorTransition: share_token CANNOT cancel estimated (only approve/decline)", () => {
  assertStrictEquals(canActorTransition("estimated", "cancelled", SHARE_TOKEN), false);
});

Deno.test("canActorTransition: terminal states reject every transition", () => {
  for (const actor of [CUSTOMER, ADMIN, MECHANIC, SYSTEM, SHARE_TOKEN]) {
    for (const from of ["completed", "cancelled"] as const) {
      for (const to of ALL_STATUSES) {
        assertStrictEquals(
          canActorTransition(from, to, actor),
          false,
          `${from}->${to} should be forbidden for all actors`,
        );
      }
    }
  }
});

Deno.test("canActorTransition: invalid transitions rejected even when actor is admin", () => {
  // draft -> in_progress is not in TRANSITIONS; admin cannot force it.
  assertStrictEquals(canActorTransition("draft", "in_progress", ADMIN), false);
  // completed -> anything
  assertStrictEquals(canActorTransition("completed", "cancelled", ADMIN), false);
});

// ---------------------------------------------------------------------------
// availableActions — UI helper
// ---------------------------------------------------------------------------

Deno.test("availableActions: customer on estimated sees approve/decline/cancel", () => {
  assertEquals(
    [...availableActions("estimated", CUSTOMER)].sort(),
    ["approved", "cancelled", "declined"],
  );
});

Deno.test("availableActions: customer on draft can only cancel", () => {
  // Chat-flow draft: customer accumulates items + appointment; if they
  // walk away mid-chat they can cancel. Shop owns the draft → approved
  // confirm transition.
  assertEquals(availableActions("draft", CUSTOMER), ["cancelled"]);
});

Deno.test("availableActions: admin on approved sees in_progress + cancelled", () => {
  assertEquals(
    [...availableActions("approved", ADMIN)].sort(),
    ["cancelled", "in_progress"],
  );
});

Deno.test("availableActions: mechanic on approved sees only in_progress", () => {
  assertEquals([...availableActions("approved", MECHANIC)], ["in_progress"]);
});

Deno.test("availableActions: terminal states return empty regardless of actor", () => {
  for (const actor of [CUSTOMER, ADMIN, MECHANIC, SYSTEM, SHARE_TOKEN]) {
    assertEquals(availableActions("completed", actor), []);
    assertEquals(availableActions("cancelled", actor), []);
  }
});

// ---------------------------------------------------------------------------
// Agent delegation (resolveAuthority via canActorTransition surface)
// ---------------------------------------------------------------------------

Deno.test("agent inherits customer authority via actingAs", () => {
  const agent: Actor = {
    kind: "agent",
    surface: "customer_chat",
    actingAs: CUSTOMER,
  };
  assertStrictEquals(canActorTransition("estimated", "approved", agent), true);
  assertStrictEquals(canActorTransition("draft", "estimated", agent), false);
});

Deno.test("agent inherits admin authority via actingAs", () => {
  const agent: Actor = {
    kind: "agent",
    surface: "staff_chat",
    actingAs: ADMIN,
  };
  assertStrictEquals(canActorTransition("draft", "estimated", agent), true);
  assertStrictEquals(canActorTransition("declined", "draft", agent), true);
});

Deno.test("agent authority does not escalate past its actingAs", () => {
  // A customer-acting agent cannot suddenly drive a mechanic-only edge.
  const customerAgent: Actor = {
    kind: "agent",
    surface: "customer_chat",
    actingAs: CUSTOMER,
  };
  assertStrictEquals(
    canActorTransition("approved", "in_progress", customerAgent),
    false,
  );
});

Deno.test("nested agent chains resolve correctly", () => {
  // Legal but weird: an agent delegating to another agent.
  const inner: Actor = {
    kind: "agent",
    surface: "customer_chat",
    actingAs: ADMIN,
  };
  const outer: Actor = {
    kind: "agent",
    surface: "staff_chat",
    actingAs: inner,
  };
  assertStrictEquals(canActorTransition("draft", "estimated", outer), true);
});

Deno.test("agent delegation depth guard throws on pathological chains", () => {
  // Build a chain 6 deep — past the depth guard of 4 hops.
  let chain: Actor = ADMIN;
  for (let i = 0; i < 6; i++) {
    chain = { kind: "agent", surface: "staff_chat", actingAs: chain };
  }
  assertThrows(
    () => canActorTransition("draft", "estimated", chain),
    Error,
    "Actor delegation chain too deep",
  );
});

// ---------------------------------------------------------------------------
// Compliance fence — customer-authorization evidence
// ---------------------------------------------------------------------------

Deno.test("fence: fenced edges are exactly the →approved edges", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      assertEquals(
        requiresCustomerAuthorization(from, to),
        to === "approved",
        `${from}->${to}`,
      );
    }
  }
});

Deno.test("fence: admin without evidence is rejected on fenced edges", () => {
  for (
    const [from, to] of [["estimated", "approved"], ["draft", "approved"]] as const
  ) {
    const r = evaluateAuthorizationFence(from, to, ADMIN);
    assertStrictEquals(r.ok, false, `${from}->${to} should require evidence`);
  }
});

Deno.test("fence: admin with evidence passes and the evidence is preserved", () => {
  const provided = { channel: "call" as const, note: "spoke with owner" };
  const r = evaluateAuthorizationFence("estimated", "approved", ADMIN, provided);
  assertStrictEquals(r.ok, true);
  if (r.ok) assertEquals(r.authorization, provided);
});

Deno.test("fence: staff agent (actingAs admin) is fenced identically to admin", () => {
  const staffAgent: Actor = { kind: "agent", surface: "staff_chat", actingAs: ADMIN };
  const rejected = evaluateAuthorizationFence("estimated", "approved", staffAgent);
  assertStrictEquals(rejected.ok, false, "resolveAuthority must fence the staff agent");

  // Walk-in shortcut (draft→approved) is fenced the same way.
  const passed = evaluateAuthorizationFence("draft", "approved", staffAgent, {
    channel: "text",
  });
  assertStrictEquals(passed.ok, true);
  if (passed.ok) assertEquals(passed.authorization?.channel, "text");
});

Deno.test("fence: customer auto-injects channel=portal without input", () => {
  const r = evaluateAuthorizationFence("estimated", "approved", CUSTOMER);
  assertStrictEquals(r.ok, true);
  if (r.ok) assertEquals(r.authorization, { channel: "portal" });
});

Deno.test("fence: share_token auto-injects channel=portal without input", () => {
  const r = evaluateAuthorizationFence("estimated", "approved", SHARE_TOKEN);
  assertStrictEquals(r.ok, true);
  if (r.ok) assertEquals(r.authorization, { channel: "portal" });
});

Deno.test("fence: customer-chat agent (actingAs customer) auto-injects portal", () => {
  const customerAgent: Actor = {
    kind: "agent",
    surface: "customer_chat",
    actingAs: CUSTOMER,
  };
  const r = evaluateAuthorizationFence("estimated", "approved", customerAgent);
  assertStrictEquals(r.ok, true);
  if (r.ok) assertEquals(r.authorization, { channel: "portal" });
});

Deno.test("fence: customer-supplied evidence cannot spoof another channel", () => {
  const r = evaluateAuthorizationFence("estimated", "approved", CUSTOMER, {
    channel: "call",
    note: "forged",
  });
  assertStrictEquals(r.ok, true);
  if (r.ok) assertEquals(r.authorization, { channel: "portal" });
});

Deno.test("fence: non-fenced transitions carry no authorization even when supplied", () => {
  const r = evaluateAuthorizationFence("draft", "estimated", ADMIN, { channel: "call" });
  assertStrictEquals(r.ok, true);
  if (r.ok) assertStrictEquals(r.authorization, undefined);
});

Deno.test("fence: approved→in_progress is not fenced (approval already evidenced)", () => {
  const r = evaluateAuthorizationFence("approved", "in_progress", ADMIN);
  assertStrictEquals(r.ok, true);
  if (r.ok) assertStrictEquals(r.authorization, undefined);
});

// ---------------------------------------------------------------------------
// Smoke: full matrix sanity — no permission can violate TRANSITIONS
// ---------------------------------------------------------------------------

Deno.test("smoke: canActorTransition implies allowedTransitions for every matrix cell", () => {
  const actors: Actor[] = [CUSTOMER, ADMIN, MECHANIC, SYSTEM, SHARE_TOKEN];
  for (const actor of actors) {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (canActorTransition(from, to, actor)) {
          const allowed = TRANSITIONS[from];
          assertEquals(
            allowed.includes(to),
            true,
            `${actor.kind} can ${from}->${to} but TRANSITIONS does not list it`,
          );
        }
      }
    }
  }
});
