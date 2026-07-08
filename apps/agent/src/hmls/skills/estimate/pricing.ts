// apps/agent/src/skills/estimate/pricing.ts

import { eq } from "drizzle-orm";
import { db, schema } from "../../../db/client.ts";
import type { DiscountType, LineItem, PricingConfig, ServiceInput } from "./types.ts";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedConfig: PricingConfig | null = null;
let cachedAt = 0;

export async function getPricingConfig(): Promise<PricingConfig> {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const rows = await db.select().from(schema.pricingConfig);
  const m = new Map(rows.map((r) => [r.key, r.value]));

  cachedConfig = {
    // Base rates
    hourlyRate: m.get("hourly_rate") ?? 14000,
    diagnosticFee: m.get("diagnostic_fee") ?? 9500,
    minimumServiceFee: m.get("minimum_service_fee") ?? 7500,

    // Time surcharges
    afterHoursFee: m.get("after_hours_fee") ?? 5000,
    rushFee: m.get("rush_fee") ?? 7500,
    weekendFee: m.get("weekend_fee") ?? 3500,
    sundayFee: m.get("sunday_fee") ?? 5000,
    holidayFee: m.get("holiday_fee") ?? 10000,
    earlyMorningFee: m.get("early_morning_fee") ?? 2500,

    // Travel
    baseTravelMiles: m.get("base_travel_miles") ?? 15,
    perMileFee: m.get("per_mile_fee") ?? 100,

    // Parts markup
    partsMarkupTier1: m.get("parts_markup_tier1_pct") ?? 40,
    partsMarkupTier2: m.get("parts_markup_tier2_pct") ?? 30,
    partsMarkupTier3: m.get("parts_markup_tier3_pct") ?? 20,
    partsMarkupTier4: m.get("parts_markup_tier4_pct") ?? 15,

    // Disposal / environmental
    hazmatDisposalFee: m.get("hazmat_disposal_fee") ?? 1500,
    tireDisposalFee: m.get("tire_disposal_fee") ?? 500,
    batteryCoreCharge: m.get("battery_core_charge") ?? 2500,

    // Discounts
    multiServiceDiscountPct: m.get("multi_service_discount_pct") ?? 10,
    returningCustomerDiscountPct: m.get("returning_customer_discount_pct") ?? 5,
    referralDiscountPct: m.get("referral_discount_pct") ?? 10,
    fleetDiscountPct: m.get("fleet_discount_pct") ?? 15,
    seniorDiscountPct: m.get("senior_discount_pct") ?? 10,
    militaryDiscountPct: m.get("military_discount_pct") ?? 10,
    firstResponderDiscountPct: m.get("first_responder_discount_pct") ?? 10,

    // Other
    noShowFee: m.get("no_show_fee") ?? 5000,
  };
  cachedAt = Date.now();

  return cachedConfig;
}

export function clearConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
}

/**
 * Look up a shop's labor rate in cents from the `shops` table.
 * Returns null if the shop is not found or the column is null (caller should
 * fall back to the global `getPricingConfig().hourlyRate`).
 */
export async function shopHourlyRate(shopId: string): Promise<number | null> {
  const [s] = await db
    .select({ rate: schema.shops.laborRateCents })
    .from(schema.shops)
    .where(eq(schema.shops.id, shopId))
    .limit(1);
  return s?.rate ?? null;
}

/** Calculate labor + parts for a single service line item */
export async function calculatePrice(
  service: ServiceInput,
  hourlyRateOverride?: number,
): Promise<LineItem> {
  const config = await getPricingConfig();
  const hourlyRate = hourlyRateOverride ?? config.hourlyRate;

  let laborCost = 0;
  let partsCost = 0;

  // Labor: hourlyRate × hours (OLP hours are already vehicle-specific)
  if (service.laborHours) {
    laborCost = Math.round(hourlyRate * service.laborHours);
  }

  // Parts markup (tiered on OEM cost)
  if (service.partsCost) {
    const costCents = Math.round(service.partsCost * 100);
    let markupPct: number;

    if (costCents < 5000) {
      markupPct = config.partsMarkupTier1;
    } else if (costCents < 20000) {
      markupPct = config.partsMarkupTier2;
    } else if (costCents < 50000) {
      markupPct = config.partsMarkupTier3;
    } else {
      markupPct = config.partsMarkupTier4;
    }

    partsCost = Math.round(costCents * (1 + markupPct / 100));
  }

  return {
    name: service.name,
    description: service.description,
    price: laborCost + partsCost,
  };
}

/** Build line items for all applicable fees */
export function buildFeeItems(
  config: PricingConfig,
  opts: {
    isRush?: boolean;
    isAfterHours?: boolean;
    isWeekend?: boolean;
    isSunday?: boolean;
    isHoliday?: boolean;
    isEarlyMorning?: boolean;
    travelMiles?: number;
    totalLaborCents: number;
    services: ServiceInput[];
  },
): LineItem[] {
  const items: LineItem[] = [];

  // Time surcharges (mutually exclusive scheduling fees — pick the highest)
  if (opts.isHoliday) {
    items.push({
      name: "Holiday Service Fee",
      description: "Holiday scheduling surcharge",
      price: config.holidayFee,
    });
  } else if (opts.isSunday) {
    items.push({
      name: "Sunday Service Fee",
      description: "Sunday scheduling surcharge",
      price: config.sundayFee,
    });
  } else if (opts.isWeekend) {
    items.push({
      name: "Weekend Service Fee",
      description: "Saturday scheduling surcharge",
      price: config.weekendFee,
    });
  }

  if (opts.isAfterHours) {
    items.push({
      name: "After-Hours Service",
      description: "Evening appointment fee (after 6pm)",
      price: config.afterHoursFee,
    });
  }

  if (opts.isEarlyMorning) {
    items.push({
      name: "Early Morning Service",
      description: "Before 8am appointment fee",
      price: config.earlyMorningFee,
    });
  }

  if (opts.isRush) {
    items.push({
      name: "Same-Day Rush",
      description: "Rush scheduling fee",
      price: config.rushFee,
    });
  }

  // Travel fee
  if (opts.travelMiles && opts.travelMiles > config.baseTravelMiles) {
    const extraMiles = opts.travelMiles - config.baseTravelMiles;
    const travelFee = extraMiles * config.perMileFee;
    items.push({
      name: "Travel Fee",
      description: `${extraMiles} mi beyond ${config.baseTravelMiles} mi base @ $${
        (config.perMileFee / 100).toFixed(2)
      }/mi`,
      price: travelFee,
    });
  }

  // Disposal / environmental fees (per service)
  let hasHazmat = false;
  let totalTires = 0;
  let hasBattery = false;

  for (const s of opts.services) {
    if (s.involvesHazmat) hasHazmat = true;
    if (s.tireCount) totalTires += s.tireCount;
    if (s.involvesBattery) hasBattery = true;
  }

  if (hasHazmat) {
    items.push({
      name: "Hazmat Disposal",
      description: "Hazardous materials disposal fee",
      price: config.hazmatDisposalFee,
    });
  }

  if (totalTires > 0) {
    items.push({
      name: "Tire Disposal",
      description: `${totalTires} tire(s) @ $${(config.tireDisposalFee / 100).toFixed(2)} each`,
      price: config.tireDisposalFee * totalTires,
    });
  }

  if (hasBattery) {
    items.push({
      name: "Battery Core Charge",
      description: "Core charge (refunded if old battery returned)",
      price: config.batteryCoreCharge,
    });
  }

  return items;
}

/** Calculate discount amount (returns positive cents to subtract).
 *  Multi-service (3+ services) and an explicitly-requested discountType are
 *  both computed when applicable, and the LARGER of the two wins — an
 *  explicit fleet/military/etc. discount must never be silently discarded
 *  in favor of a smaller multi-service discount just because it fires
 *  first, and vice versa. */
export function calculateDiscount(
  config: PricingConfig,
  subtotalCents: number,
  discountType?: DiscountType,
  serviceCount?: number,
): { amount: number; label: string } | null {
  const multiService = serviceCount && serviceCount >= 3
    ? {
      amount: Math.round(subtotalCents * (config.multiServiceDiscountPct / 100)),
      label: `Multi-service discount (${config.multiServiceDiscountPct}%)`,
    }
    : null;

  const discountMap: Record<DiscountType, { pct: number; label: string }> = {
    multi_service: {
      pct: config.multiServiceDiscountPct,
      label: "Multi-service discount",
    },
    returning_customer: {
      pct: config.returningCustomerDiscountPct,
      label: "Returning customer discount",
    },
    referral: { pct: config.referralDiscountPct, label: "Referral discount" },
    fleet: { pct: config.fleetDiscountPct, label: "Fleet discount" },
    senior: { pct: config.seniorDiscountPct, label: "Senior discount" },
    military: {
      pct: config.militaryDiscountPct,
      label: "Military/veteran discount",
    },
    first_responder: {
      pct: config.firstResponderDiscountPct,
      label: "First responder discount",
    },
  };

  const requested = discountType ? discountMap[discountType] : undefined;
  const explicit = requested && requested.pct > 0
    ? {
      amount: Math.round(subtotalCents * (requested.pct / 100)),
      label: `${requested.label} (${requested.pct}%)`,
    }
    : null;

  if (multiService && explicit) {
    return explicit.amount >= multiService.amount ? explicit : multiService;
  }
  return explicit ?? multiService;
}
