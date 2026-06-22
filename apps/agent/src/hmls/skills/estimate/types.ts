// apps/agent/src/skills/estimate/types.ts

import type { ItemTier } from "@hmls/shared/db/schema";

export interface ServiceInput {
  name: string;
  description: string;
  laborHours?: number;
  partsCost?: number;
  /** Service involves hazardous fluids (oil, coolant, brake fluid, etc.) */
  involvesHazmat?: boolean;
  /** Number of tires being disposed */
  tireCount?: number;
  /** Service involves battery replacement */
  involvesBattery?: boolean;
  /** Customer is bringing their own parts. The agent omits `partsCost`
   *  (or sets it to 0) for that service line; only labor is billed. The
   *  shop verifies on review. */
  customerSuppliedParts?: boolean;
  /** Repair urgency tier surfaced on the resulting OrderItem so customers
   *  can triage by severity (required / recommended / maintenance / optional). */
  tier?: ItemTier;
  /** OLP job slug (the `slug` from lookup_labor_time). Lets create_order attach
   *  internal tech-prep (tools / difficulty / HV-safety) from the repair_jobs
   *  catalog onto the labor item. Optional; enrichment is skipped if absent. */
  jobSlug?: string;
}

export interface LineItem {
  name: string;
  description: string;
  price: number; // in cents
}

export interface PricingConfig {
  // Base rates
  hourlyRate: number;
  diagnosticFee: number;
  minimumServiceFee: number;

  // Time surcharges
  afterHoursFee: number;
  rushFee: number;
  weekendFee: number;
  sundayFee: number;
  holidayFee: number;
  earlyMorningFee: number;

  // Travel
  baseTravelMiles: number;
  perMileFee: number;

  // Parts markup tiers (percentages)
  partsMarkupTier1: number; // < $50
  partsMarkupTier2: number; // $50-200
  partsMarkupTier3: number; // $200-500
  partsMarkupTier4: number; // > $500

  // Disposal / environmental
  hazmatDisposalFee: number;
  tireDisposalFee: number; // per tire
  batteryCoreCharge: number;

  // Discounts (percentages)
  multiServiceDiscountPct: number;
  returningCustomerDiscountPct: number;
  referralDiscountPct: number;
  fleetDiscountPct: number;
  seniorDiscountPct: number;
  militaryDiscountPct: number;
  firstResponderDiscountPct: number;

  // Other
  noShowFee: number;
}

export type DiscountType =
  | "multi_service"
  | "returning_customer"
  | "referral"
  | "fleet"
  | "senior"
  | "military"
  | "first_responder";

export interface EstimateResult {
  success: boolean;
  estimateId: number;
  downloadUrl: string;
  shareUrl: string;
  subtotal: number;
  priceRange: string;
  expiresAt: Date;
}
