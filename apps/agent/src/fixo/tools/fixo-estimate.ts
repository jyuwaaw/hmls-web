// apps/agent/src/fixo/tools/fixo-estimate.ts
//
// Fixo-specific estimate tool: writes to `fixo_estimates` table instead of `orders`.
// Uses userId from auth context rather than legacy customerId lookup.

import { z } from "zod";
import { nanoid } from "nanoid";
import { db, schema } from "../../db/client.ts";
import {
  buildFeeItems,
  calculateDiscount,
  calculatePrice,
  getPricingConfig,
} from "../../hmls/skills/estimate/pricing.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { DiscountType, LineItem, ServiceInput } from "../../hmls/skills/estimate/types.ts";
import type { ItemTier, OrderItem } from "@hmls/shared/db/schema";
import type { ToolContext } from "../../common/convert-tools.ts";

function asToolContext(ctx: unknown): ToolContext | undefined {
  if (ctx && typeof ctx === "object" && "userId" in ctx) {
    return ctx as ToolContext;
  }
  return undefined;
}

const discountEnum = z.enum([
  "returning_customer",
  "referral",
  "fleet",
  "senior",
  "military",
  "first_responder",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a legacy LineItem into the unified OrderItem format. */
function toOrderItem(
  item: LineItem,
  category: OrderItem["category"],
  opts?: { laborHours?: number; quantity?: number; tier?: ItemTier },
): OrderItem {
  const quantity = opts?.quantity ?? 1;
  return {
    id: crypto.randomUUID(),
    category,
    name: item.name,
    description: item.description || undefined,
    quantity,
    unitPriceCents: item.price,
    totalCents: item.price * quantity,
    taxable: category !== "discount",
    ...(opts?.laborHours ? { laborHours: opts.laborHours } : {}),
    ...(opts?.tier ? { tier: opts.tier } : {}),
  };
}

const tierEnum = z.enum(["required", "recommended", "maintenance", "optional"]);

// ---------------------------------------------------------------------------
// create_fixo_estimate  →  creates a fixo_estimates row
// ---------------------------------------------------------------------------

export const createFixoEstimateTool = {
  name: "create_estimate",
  description:
    "Generate a price estimate for services. Provide vehicle info directly (year/make/model). " +
    "The system automatically applies disposal fees, time surcharges, travel fees, and discounts. " +
    "Estimates are saved to the user's Fixo account when they are signed in.",
  schema: z.object({
    vehicle: z
      .object({
        year: z.number().describe("Vehicle year, e.g. 2015"),
        make: z.string().describe("Vehicle make, e.g. 'Honda'"),
        model: z.string().describe("Vehicle model, e.g. 'Civic'"),
      })
      .describe("Vehicle the estimate is for"),
    services: z
      .array(
        z.object({
          name: z.string().describe("Service name"),
          description: z.string().describe("Brief description"),
          laborHours: z
            .number()
            .optional()
            .describe(
              "Labor hours from OLP lookup, or your best estimate if OLP has no data",
            ),
          partsCost: z
            .number()
            .optional()
            .describe("Estimated parts cost in dollars"),
          involvesHazmat: z
            .boolean()
            .default(false)
            .describe(
              "True if service involves hazardous fluids (oil change, coolant flush, brake fluid, etc.)",
            ),
          tireCount: z
            .number()
            .optional()
            .describe("Number of tires being disposed (tire services only)"),
          involvesBattery: z
            .boolean()
            .default(false)
            .describe("True if service involves battery replacement"),
          tier: tierEnum
            .optional()
            .describe(
              "Repair urgency tier: 'required' = safety-critical or vehicle inoperable; " +
                "'recommended' = fix soon, not urgent; 'maintenance' = routine service " +
                "interval; 'optional' = cosmetic / nice-to-have. Customers triage by tier.",
            ),
        }),
      )
      .describe("List of services to include in estimate"),
    customItems: z
      .array(
        z.object({
          name: z.string().describe("Item name (e.g. 'Diagnostic Fee', 'Custom Fabrication')"),
          description: z.string().describe("Brief description of the charge"),
          price: z.number().describe("Price in dollars (e.g. 95 for $95)"),
        }),
      )
      .optional()
      .describe(
        "Freeform line items that bypass the labor/parts pricing engine. Use for diagnostic fees, custom work, flat-rate services, or anything not in OLP.",
      ),
    notes: z
      .string()
      .optional()
      .describe("Additional notes for the estimate"),
    validDays: z
      .number()
      .default(14)
      .describe("Days until estimate expires"),

    // Scheduling
    isRush: z
      .boolean()
      .default(false)
      .describe("Same-day service requested"),
    isAfterHours: z
      .boolean()
      .default(false)
      .describe("After 6pm appointment"),
    isEarlyMorning: z
      .boolean()
      .default(false)
      .describe("Before 8am appointment"),
    isWeekend: z
      .boolean()
      .default(false)
      .describe("Saturday appointment"),
    isSunday: z
      .boolean()
      .default(false)
      .describe("Sunday appointment"),
    isHoliday: z
      .boolean()
      .default(false)
      .describe("Holiday appointment"),

    // Travel
    travelMiles: z
      .number()
      .optional()
      .describe(
        "Distance to customer in miles. First 15 mi are free, then $1/mi.",
      ),

    // Discount
    discountType: discountEnum
      .optional()
      .describe(
        "Discount type to apply (returning_customer, referral, fleet, senior, military, first_responder)",
      ),
  }),
  execute: async (
    params: {
      vehicle: { year: number; make: string; model: string };
      services: ServiceInput[];
      customItems?: { name: string; description: string; price: number }[];
      notes?: string;
      validDays?: number;
      isRush?: boolean;
      isAfterHours?: boolean;
      isEarlyMorning?: boolean;
      isWeekend?: boolean;
      isSunday?: boolean;
      isHoliday?: boolean;
      travelMiles?: number;
      discountType?: DiscountType;
    },
    rawCtx: unknown,
  ) => {
    const userId = asToolContext(rawCtx)?.userId;

    // 1. Calculate service line items (labor + parts)
    const serviceLineItems = await Promise.all(
      params.services.map((s) => calculatePrice(s)),
    );

    // 1b. Convert custom items (dollars → cents)
    const customLineItems: LineItem[] = (params.customItems ?? []).map((c) => ({
      name: c.name,
      description: c.description,
      price: Math.round(c.price * 100),
    }));

    const config = await getPricingConfig();
    const laborCents = params.services.reduce(
      (sum, s) => sum + Math.round((s.laborHours ?? 0) * config.hourlyRate),
      0,
    );

    // 2. Build fee line items
    const feeLineItems = buildFeeItems(config, {
      isRush: params.isRush,
      isAfterHours: params.isAfterHours,
      isWeekend: params.isWeekend,
      isSunday: params.isSunday,
      isHoliday: params.isHoliday,
      isEarlyMorning: params.isEarlyMorning,
      travelMiles: params.travelMiles,
      totalLaborCents: laborCents,
      services: params.services,
    });

    // 3. Convert LineItems → OrderItem[] (unified item model)
    const orderItems: OrderItem[] = [
      ...serviceLineItems.map((li, i) =>
        toOrderItem(li, "labor", {
          laborHours: params.services[i]?.laborHours,
          tier: params.services[i]?.tier,
        })
      ),
      ...customLineItems.map((li) => toOrderItem(li, "labor")),
      ...feeLineItems.map((li) => toOrderItem(li, "fee")),
    ];

    // 4. Calculate subtotal before discount
    const subtotalBeforeDiscount = orderItems.reduce(
      (sum, item) => sum + item.totalCents,
      0,
    );

    // 5. Apply discount
    const discount = calculateDiscount(
      config,
      subtotalBeforeDiscount,
      params.discountType,
      params.services.length,
    );

    if (discount && discount.amount > 0) {
      orderItems.push({
        id: crypto.randomUUID(),
        category: "discount",
        name: "Discount",
        description: discount.label,
        quantity: 1,
        unitPriceCents: -discount.amount,
        totalCents: -discount.amount,
        taxable: false,
      });
    }

    // 6. Final subtotal (enforce minimum service fee)
    let subtotal = orderItems.reduce((sum, item) => sum + item.totalCents, 0);
    if (subtotal < config.minimumServiceFee) {
      subtotal = config.minimumServiceFee;
    }

    const rangeLow = Math.round(subtotal * 0.9);
    const rangeHigh = Math.round(subtotal * 1.1);

    // 7. Generate share token
    const shareToken = nanoid(32);
    const validDays = params.validDays ?? 14;
    const expiresAt = new Date(
      Date.now() + validDays * 24 * 60 * 60 * 1000,
    );

    const itemSummary = orderItems.map((i) => ({
      name: i.name,
      description: i.description,
      unitPriceCents: i.unitPriceCents,
      totalCents: i.totalCents,
      quantity: i.quantity,
      category: i.category,
      tier: i.tier,
    }));

    // 8. Save to fixo_estimates if user is authenticated, otherwise return pricing only
    if (userId) {
      const [estimate] = await db
        .insert(schema.fixoEstimates)
        .values({
          userId,
          vehicleInfo: {
            year: params.vehicle.year,
            make: params.vehicle.make,
            model: params.vehicle.model,
          },
          items: orderItems,
          notes: params.notes ?? null,
          subtotalCents: subtotal,
          priceRangeLowCents: rangeLow,
          priceRangeHighCents: rangeHigh,
          shareToken,
          validDays,
          expiresAt,
        })
        .returning();

      return toolResult({
        success: true,
        estimateId: estimate.id,
        vehicle: `${params.vehicle.year} ${params.vehicle.make} ${params.vehicle.model}`,
        shareToken: estimate.shareToken,
        items: itemSummary,
        subtotal: subtotal / 100,
        priceRange: `$${(rangeLow / 100).toFixed(2)} - $${(rangeHigh / 100).toFixed(2)}`,
        expiresAt,
      });
    }

    // Anonymous user — return pricing without saving
    return toolResult({
      success: true,
      vehicle: `${params.vehicle.year} ${params.vehicle.make} ${params.vehicle.model}`,
      items: itemSummary,
      subtotal: subtotal / 100,
      priceRange: `$${(rangeLow / 100).toFixed(2)} - $${(rangeHigh / 100).toFixed(2)}`,
      note: "Estimate not saved — user not signed in.",
    });
  },
};
