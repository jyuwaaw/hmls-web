// Pure unit tests for calculateDiscount. No DB.
//
// Regression coverage for the bug where the multi-service (3+ services)
// branch returned unconditionally, silently discarding a larger explicit
// discountType (e.g. fleet 15%) requested alongside it.

import { assertEquals } from "@std/assert";
import { calculateDiscount } from "./pricing.ts";
import type { PricingConfig } from "./types.ts";

const CONFIG: PricingConfig = {
  hourlyRate: 14000,
  diagnosticFee: 9500,
  minimumServiceFee: 7500,
  afterHoursFee: 5000,
  rushFee: 7500,
  weekendFee: 3500,
  sundayFee: 5000,
  holidayFee: 10000,
  earlyMorningFee: 2500,
  baseTravelMiles: 15,
  perMileFee: 100,
  partsMarkupTier1: 40,
  partsMarkupTier2: 30,
  partsMarkupTier3: 20,
  partsMarkupTier4: 15,
  hazmatDisposalFee: 1500,
  tireDisposalFee: 500,
  batteryCoreCharge: 2500,
  multiServiceDiscountPct: 10,
  returningCustomerDiscountPct: 5,
  referralDiscountPct: 10,
  fleetDiscountPct: 15,
  seniorDiscountPct: 10,
  militaryDiscountPct: 10,
  firstResponderDiscountPct: 10,
  noShowFee: 5000,
};

const SUBTOTAL = 100_00; // $100.00 in cents

Deno.test("calculateDiscount: 3+ services + explicit fleet (15%) — fleet wins over multi-service (10%)", () => {
  const result = calculateDiscount(CONFIG, SUBTOTAL, "fleet", 3);
  assertEquals(result?.amount, 1500); // 15% of 10000
  assertEquals(result?.label.startsWith("Fleet discount"), true);
});

Deno.test("calculateDiscount: 3+ services, no explicit discountType — multi-service applies", () => {
  const result = calculateDiscount(CONFIG, SUBTOTAL, undefined, 3);
  assertEquals(result?.amount, 1000); // 10% of 10000
  assertEquals(result?.label.startsWith("Multi-service discount"), true);
});

Deno.test("calculateDiscount: 3+ services + smaller explicit discount (returning_customer, 5%) — multi-service wins", () => {
  const result = calculateDiscount(CONFIG, SUBTOTAL, "returning_customer", 3);
  assertEquals(result?.amount, 1000); // 10% multi-service beats 5% returning-customer
  assertEquals(result?.label.startsWith("Multi-service discount"), true);
});

Deno.test("calculateDiscount: <3 services + explicit discount — explicit applies alone", () => {
  const result = calculateDiscount(CONFIG, SUBTOTAL, "senior", 1);
  assertEquals(result?.amount, 1000); // 10% senior
  assertEquals(result?.label.startsWith("Senior discount"), true);
});

Deno.test("calculateDiscount: <3 services, no discountType — no discount", () => {
  const result = calculateDiscount(CONFIG, SUBTOTAL, undefined, 1);
  assertEquals(result, null);
});
