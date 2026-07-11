import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  canonicalizeStatus,
  completionMissingDiagnosis,
  getOrderStepState,
  hasBeenSentToCustomer,
  ORDER_BRANCH_STATUSES,
  ORDER_MAIN_STEPS,
  type OrderStatus,
  physicalStatusLabels,
  TRANSITIONS,
} from "./status.ts";

const CANONICAL: readonly OrderStatus[] = [
  "draft",
  "estimated",
  "approved",
  "declined",
  "in_progress",
  "completed",
  "cancelled",
];

// ---------------------------------------------------------------------------
// canonicalizeStatus — the single alias-tolerance point
// ---------------------------------------------------------------------------

Deno.test("canonicalizeStatus: legacy scheduled maps to approved", () => {
  assertEquals(canonicalizeStatus("scheduled"), "approved");
});

Deno.test("canonicalizeStatus: legacy revised maps to draft", () => {
  assertEquals(canonicalizeStatus("revised"), "draft");
});

Deno.test("canonicalizeStatus: canonical statuses pass through unchanged", () => {
  for (const s of CANONICAL) {
    assertEquals(canonicalizeStatus(s), s);
  }
});

Deno.test("canonicalizeStatus: unknown status throws", () => {
  assertThrows(() => canonicalizeStatus("banana"), Error, "Unknown order status");
  assertThrows(() => canonicalizeStatus(""), Error, "Unknown order status");
  // Removed by 0008 long ago — must NOT silently pass.
  assertThrows(() => canonicalizeStatus("preauth"), Error, "Unknown order status");
});

Deno.test("physicalStatusLabels: approved includes legacy scheduled", () => {
  assertEquals([...physicalStatusLabels("approved")].sort(), ["approved", "scheduled"]);
});

Deno.test("physicalStatusLabels: draft includes legacy revised", () => {
  assertEquals([...physicalStatusLabels("draft")].sort(), ["draft", "revised"]);
});

Deno.test("physicalStatusLabels: statuses without aliases are singletons", () => {
  for (const s of ["estimated", "declined", "in_progress", "completed", "cancelled"] as const) {
    assertEquals(physicalStatusLabels(s), [s]);
  }
});

// ---------------------------------------------------------------------------
// hasBeenSentToCustomer — draft dual-semantics predicate
// ---------------------------------------------------------------------------

Deno.test("hasBeenSentToCustomer: fresh draft (never sent) is false", () => {
  const order = {
    statusHistory: [
      { status: "draft", timestamp: "2026-07-01T00:00:00.000Z", actor: "test" },
    ],
  };
  assertEquals(hasBeenSentToCustomer(order), false);
});

Deno.test("hasBeenSentToCustomer: pulled-back draft (sent then edited) is true", () => {
  const order = {
    statusHistory: [
      { status: "draft", timestamp: "2026-07-01T00:00:00.000Z", actor: "test" },
      { status: "estimated", timestamp: "2026-07-02T00:00:00.000Z", actor: "admin:a@shop.com" },
      { status: "draft", timestamp: "2026-07-03T00:00:00.000Z", actor: "admin:a@shop.com" },
    ],
  };
  assertEquals(hasBeenSentToCustomer(order), true);
});

Deno.test("hasBeenSentToCustomer: null / empty history is false (row-local, no queries)", () => {
  assertEquals(hasBeenSentToCustomer({ statusHistory: null }), false);
  assertEquals(hasBeenSentToCustomer({ statusHistory: undefined }), false);
  assertEquals(hasBeenSentToCustomer({ statusHistory: [] }), false);
});

// ---------------------------------------------------------------------------
// Step-progress helpers — 7-state shape
// ---------------------------------------------------------------------------

Deno.test("ORDER_MAIN_STEPS: linear path has no scheduled step", () => {
  assertEquals(
    [...ORDER_MAIN_STEPS],
    ["draft", "estimated", "approved", "in_progress", "completed"],
  );
});

Deno.test("ORDER_BRANCH_STATUSES: only declined branches (revised is gone)", () => {
  assertEquals([...ORDER_BRANCH_STATUSES], ["declined"]);
});

Deno.test("every main step and branch status exists in TRANSITIONS", () => {
  for (const s of [...ORDER_MAIN_STEPS, ...ORDER_BRANCH_STATUSES]) {
    assert(s in TRANSITIONS, `${s} missing from TRANSITIONS`);
  }
});

Deno.test("getOrderStepState: approved order marks earlier steps completed, later pending", () => {
  assertEquals(getOrderStepState("draft", "approved"), "completed");
  assertEquals(getOrderStepState("estimated", "approved"), "completed");
  assertEquals(getOrderStepState("approved", "approved"), "current");
  assertEquals(getOrderStepState("in_progress", "approved"), "pending");
  assertEquals(getOrderStepState("completed", "approved"), "pending");
});

Deno.test("getOrderStepState: declined branch reads as through-estimated", () => {
  assertEquals(getOrderStepState("draft", "declined"), "completed");
  assertEquals(getOrderStepState("estimated", "declined"), "completed");
  assertEquals(getOrderStepState("approved", "declined"), "pending");
});

// ---------------------------------------------------------------------------
// completionMissingDiagnosis
// ---------------------------------------------------------------------------

Deno.test("completionMissingDiagnosis — blocks completion when diagnosis is empty/blank", () => {
  assertEquals(completionMissingDiagnosis("completed", ""), true);
  assertEquals(completionMissingDiagnosis("completed", "   "), true);
  assertEquals(completionMissingDiagnosis("completed", null), true);
  assertEquals(completionMissingDiagnosis("completed", undefined), true);
});

Deno.test("completionMissingDiagnosis — allows completion when diagnosis present", () => {
  assertEquals(completionMissingDiagnosis("completed", "worn front pads"), false);
  assertEquals(completionMissingDiagnosis("completed", "  rotors warped  "), false);
});

Deno.test("completionMissingDiagnosis — only gates completion, never other transitions", () => {
  assertEquals(completionMissingDiagnosis("in_progress", ""), false);
  assertEquals(completionMissingDiagnosis("cancelled", ""), false);
  assertEquals(completionMissingDiagnosis("approved", null), false);
});
