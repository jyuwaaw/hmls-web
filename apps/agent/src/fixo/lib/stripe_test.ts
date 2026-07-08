import { assertEquals } from "@std/assert";
import { refundDelta } from "./stripe.ts";

// $20 charge (2000 cents) → 2000 credits granted.
Deno.test("refundDelta — sequential partial refunds never double-deduct", () => {
  const granted = 2000;
  const amount = 2000; // cents

  // Refund $10: cumulative amount_refunded = 1000 cents, nothing revoked yet.
  const first = refundDelta(granted, amount, 1000, 0);
  assertEquals(first, 1000);

  // Refund another $5: cumulative amount_refunded = 1500 cents, 1000 already revoked.
  const second = refundDelta(granted, amount, 1500, first);
  assertEquals(second, 500);

  // Total revoked across both events is 1500, not 2500.
  assertEquals(first + second, 1500);
});

Deno.test("refundDelta — full refund in one event revokes the whole grant", () => {
  assertEquals(refundDelta(2000, 2000, 2000, 0), 2000);
});

Deno.test("refundDelta — replayed/stale event yields 0 (already fully accounted)", () => {
  // Cumulative 1500 already revoked; a retry of the same event re-reads 1500.
  assertEquals(refundDelta(2000, 2000, 1500, 1500), 0);
});

Deno.test("refundDelta — floors partial fractions", () => {
  // $20 → 2000cr, refund $3.33 (333 cents): floor(2000 * 333/2000) = 333.
  assertEquals(refundDelta(2000, 2000, 333, 0), 333);
});

Deno.test("refundDelta — non-positive amount is a no-op (never over-revoke on garbage)", () => {
  assertEquals(refundDelta(2000, 0, 1000, 0), 0);
});

Deno.test("refundDelta — clamps at 0 when alreadyRevoked exceeds target", () => {
  assertEquals(refundDelta(2000, 2000, 1000, 1500), 0);
});
