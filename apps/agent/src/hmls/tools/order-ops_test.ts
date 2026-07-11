// L1 (no-DB) tests for the staff order-ops tools: sensitive-tool
// confirmation layer (Codex C8) + input validation paths that short-circuit
// before any DB access. DB-backed behavior lives in order-ops_db_test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { orderOpsTools, staffOrderOpsTools } from "./order-ops.ts";
import type { LegacyTool } from "../../common/convert-tools.ts";

const assignMechanic: LegacyTool = staffOrderOpsTools.find((t) => t.name === "assign_mechanic")!;
const recordPayment: LegacyTool = staffOrderOpsTools.find((t) => t.name === "record_payment")!;
const transitionStatus: LegacyTool = orderOpsTools.find((t) =>
  t.name === "transition_order_status"
)!;

type ToolError = { success: boolean; error?: string };

// ---------------------------------------------------------------------------
// Sensitivity descriptions (Codex C8 pin tests): the model-facing text MUST
// carry the echo-then-confirm instruction.
// ---------------------------------------------------------------------------

Deno.test("record_payment description instructs echo-and-confirm before calling", () => {
  assertStringIncludes(recordPayment.description, "SENSITIVE");
  assertStringIncludes(recordPayment.description, "echo");
  assertStringIncludes(recordPayment.description, "confirmed: true");
});

Deno.test("transition_order_status description fences 'cancelled' behind confirmation", () => {
  assertStringIncludes(transitionStatus.description, "SENSITIVE");
  assertStringIncludes(transitionStatus.description, "cancelled");
  assertStringIncludes(transitionStatus.description, "confirm");
});

Deno.test("assign_mechanic description fences re-dispatch behind confirmation", () => {
  assertStringIncludes(assignMechanic.description, "SENSITIVE");
  assertStringIncludes(assignMechanic.description, "confirmReassign: true");
});

// ---------------------------------------------------------------------------
// record_payment schema + confirmation logic
// ---------------------------------------------------------------------------

Deno.test("record_payment schema: 'confirmed' is required — absent fails parse", () => {
  const parsed = recordPayment.schema.safeParse({
    orderId: "1",
    amountCents: 18000,
    method: "cash",
  });
  assertEquals(parsed.success, false);
});

Deno.test("record_payment schema: rejects unknown payment method", () => {
  const parsed = recordPayment.schema.safeParse({
    orderId: "1",
    amountCents: 18000,
    method: "bitcoin",
    confirmed: true,
  });
  assertEquals(parsed.success, false);
});

Deno.test("record_payment schema: accepts a valid confirmed payload", () => {
  const parsed = recordPayment.schema.safeParse({
    orderId: "1",
    amountCents: 18000,
    method: "cash",
    reference: "till #2",
    confirmed: true,
  });
  assertEquals(parsed.success, true);
});

Deno.test("record_payment: confirmed:false is rejected before any DB access", async () => {
  const res = await recordPayment.execute(
    { orderId: "1", amountCents: 18000, method: "cash", confirmed: false },
    { shopId: "00000000-0000-0000-0000-000000000000" },
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "confirmation");
  assertStringIncludes(res.error!, "confirmed: true");
});

Deno.test("record_payment: invalid paidAt rejected", async () => {
  const res = await recordPayment.execute(
    { orderId: "1", amountCents: 100, method: "cash", confirmed: true, paidAt: "yesterday-ish" },
    undefined,
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "paidAt");
});

Deno.test("record_payment: no tenant context → not found (write denied)", async () => {
  // canWrite(no ctx) = false short-circuits before orderAccessible's DB read.
  const res = await recordPayment.execute(
    { orderId: "1", amountCents: 100, method: "cash", confirmed: true },
    undefined,
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "not found");
});

// ---------------------------------------------------------------------------
// assign_mechanic input validation
// ---------------------------------------------------------------------------

Deno.test("assign_mechanic: requires providerId or providerName", async () => {
  const res = await assignMechanic.execute(
    { orderId: "1" },
    { shopId: "00000000-0000-0000-0000-000000000000" },
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "providerId or providerName");
});

Deno.test("assign_mechanic: invalid order id rejected", async () => {
  const res = await assignMechanic.execute(
    { orderId: "abc", providerId: 1 },
    { shopId: "00000000-0000-0000-0000-000000000000" },
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "Invalid order ID");
});

Deno.test("assign_mechanic: owner-all-shops context is write-denied", async () => {
  // Writes are forbidden for an owner with no concrete shop (canWrite=false,
  // short-circuits before DB).
  const res = await assignMechanic.execute(
    { orderId: "1", providerId: 1 },
    { shopId: "__all__" },
  ) as ToolError;
  assertEquals(res.success, false);
  assertStringIncludes(res.error!, "not found");
});

Deno.test("staff tool registration: both tools exported, customer set untouched", () => {
  assertEquals(staffOrderOpsTools.map((t) => t.name), ["assign_mechanic", "record_payment"]);
  // The customer agent cherry-picks from orderOpsTools by name — the staff-only
  // tools must not live there.
  assert(!orderOpsTools.some((t) => t.name === "assign_mechanic"));
  assert(!orderOpsTools.some((t) => t.name === "record_payment"));
});
