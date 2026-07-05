// apps/agent/src/common/tools/order.ts
//
// Unified order creation/update tool. Replaces the old `create_estimate` and
// `create_order` tools — orders is the single source of truth, so a single
// "upsert with full pricing engine" tool covers both customer- and staff-side
// flows.
//
// Idempotency: pass `orderId` to update an existing draft/revised/estimated
// order in place (re-runs the full pricing engine). Without `orderId`, inserts
// a new draft. Updating an `estimated` order auto-flips it back to `revised`,
// matching the existing modify_order_items semantics.

import { z } from "zod";
import { and, eq, ilike, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, dbAdmin, schema } from "../../db/client.ts";
import { shouldClaimShop } from "./claim-shop.ts";
import { type AccessCtx, canWrite, orderAccessible, OWNER_ALL_SHOPS } from "../../db/tenant.ts";
import {
  buildFeeItems,
  calculateDiscount,
  calculatePrice,
  getPricingConfig,
  shopHourlyRate,
} from "../../hmls/skills/estimate/pricing.ts";
import {
  type Coords,
  geocodeAddress,
  routeOrderToShop,
  routingReviewNote,
} from "../shop-routing.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { DiscountType, LineItem, ServiceInput } from "../../hmls/skills/estimate/types.ts";
import type { OrderItem, RepairTechPrep } from "@hmls/shared/db/schema";
import { getRepairJobs } from "../../hmls/tools/olp-client.ts";
import { patchItems } from "../../services/order-state.ts";
import { upsertOrderIntake } from "../../services/order-intake.ts";
import { fillPrediction, openPrediction, recordEstimate } from "../../fixo/fixo-brain.ts";
import {
  customerAgentActor,
  staffAgentActor,
  toolResultFromOrderState,
} from "../../services/order-state-tool.ts";
import type { ToolContext } from "../convert-tools.ts";

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

function toOrderItem(
  item: LineItem,
  category: OrderItem["category"],
  opts?: { laborHours?: number; quantity?: number; techPrep?: RepairTechPrep },
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
    ...(opts?.techPrep ? { techPrep: opts.techPrep } : {}),
  };
}

type CustomerRecord = {
  id: number;
  shopId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
};

type CustomerInfoInput = {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  serviceZip?: string;
};

/** Trim and normalize empty / null inputs to undefined so we don't overwrite
 *  real data with "" or accidentally clear a column when the caller only
 *  meant "no change". Callers that explicitly want to clear a column on
 *  UPDATE should pass `null` directly to patchItems, not via clean(). */
function clean(v: string | null | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Resolve the customer for this order in priority order:
 *  1. Auth context (customer chat) — never overrideable by the model
 *  2. Explicit `customerId` (staff for known customer)
 *  3. `customerInfo` lookup-by-email or create-as-guest (staff walk-in)
 *  4. null (orphan order — staff can attach a customer later)
 *
 * Profile defaults: when `customerInfo` carries phone or address that the
 * resolved customer record is missing, fill the blank on the customers row.
 * Existing values are never overwritten — the customer profile is the
 * stable default, while orders.contactPhone/contactAddress are the
 * authoritative per-order snapshot (which may differ from the default).
 */
async function resolveCustomer(
  ctxCustomerId: number | undefined,
  paramCustomerId: number | undefined,
  customerInfo: CustomerInfoInput | undefined,
  access: AccessCtx,
  defaultShopId?: string,
): Promise<CustomerRecord | null> {
  const phoneIn = clean(customerInfo?.phone);
  const addressIn = clean(customerInfo?.address);
  const nameIn = clean(customerInfo?.name);
  const emailIn = clean(customerInfo?.email);

  const id = ctxCustomerId ?? paramCustomerId;
  if (id) {
    const [found] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!found) return null;

    // Ownership gate: a customer agent may only resolve its own customer id;
    // staff may only resolve a customer in their own shop. Owner all-shops may
    // resolve any (read context — writes are blocked upstream by canWrite).
    if (access.customerId != null) {
      if (found.id !== access.customerId) return null;
    } else if (access.shopId && access.shopId !== OWNER_ALL_SHOPS) {
      if (found.shopId !== access.shopId) return null;
    }

    const patch: Partial<typeof schema.customers.$inferInsert> = {};
    if (phoneIn && !found.phone) patch.phone = phoneIn;
    if (addressIn && !found.address) patch.address = addressIn;
    if (Object.keys(patch).length > 0) {
      const [updated] = await db
        .update(schema.customers)
        .set(patch)
        .where(eq(schema.customers.id, id))
        .returning();
      return updated ?? found;
    }
    return found;
  }

  // Need at least one real identifier (name, email, OR phone) before
  // creating a guest customer. Address alone isn't a dedup key — accepting
  // address-only would fragment a customer's history into orphan records
  // every time staff types just a service location for a walk-in.
  if (!nameIn && !emailIn && !phoneIn) return null;

  if (emailIn) {
    // Scope the email lookup to the staff caller's shop so shop A cannot
    // find-or-attach a shop B customer by guessing their email. Customer
    // agents never reach this branch (their id resolves above); owner
    // all-shops may match any (writes blocked upstream by canWrite).
    const emailMatch = ilike(schema.customers.email, emailIn);
    const emailWhere = access.customerId == null && access.shopId &&
        access.shopId !== OWNER_ALL_SHOPS
      ? and(emailMatch, eq(schema.customers.shopId, access.shopId))
      : emailMatch;
    const [existing] = await db
      .select()
      .from(schema.customers)
      .where(emailWhere)
      .limit(1);
    if (existing) {
      const patch: Partial<typeof schema.customers.$inferInsert> = {};
      if (phoneIn && !existing.phone) patch.phone = phoneIn;
      if (addressIn && !existing.address) patch.address = addressIn;
      if (Object.keys(patch).length > 0) {
        const [updated] = await db
          .update(schema.customers)
          .set(patch)
          .where(eq(schema.customers.id, existing.id))
          .returning();
        return updated ?? existing;
      }
      return existing;
    }
  }

  const [created] = await db
    .insert(schema.customers)
    .values({
      // shop_id is NOT NULL. INSERT-branch callers pass defaultShopId
      // (routed from the order address). The UPDATE branch omits it, so for
      // the rare guest-create-on-revise, route from the new customer's address.
      shopId: defaultShopId ?? (await routeOrderToShop(addressIn ?? null)).shopId,
      name: nameIn ?? null,
      email: emailIn ?? null,
      phone: phoneIn ?? null,
      address: addressIn ?? null,
    })
    .returning();
  return created ?? null;
}

// ---------------------------------------------------------------------------
// Pricing — shared between insert and update paths
// ---------------------------------------------------------------------------

interface PriceServicesInput {
  services: ServiceInput[];
  customItems?: { name: string; description: string; price: number }[];
  isRush?: boolean;
  isAfterHours?: boolean;
  isEarlyMorning?: boolean;
  isWeekend?: boolean;
  isSunday?: boolean;
  isHoliday?: boolean;
  travelMiles?: number;
  discountType?: DiscountType;
  vehicle?: { year: number; make: string; model: string };
  /** Shop-specific labor rate override (cents). Falls back to global hourlyRate when omitted. */
  hourlyRateOverride?: number;
}

async function priceServices(input: PriceServicesInput): Promise<{
  items: OrderItem[];
  subtotal: number;
  rangeLow: number;
  rangeHigh: number;
}> {
  const services = input.services;
  const serviceLineItems = await Promise.all(
    services.map((s) => calculatePrice(s, input.hourlyRateOverride)),
  );

  const customLineItems: LineItem[] = (input.customItems ?? []).map((c) => ({
    name: c.name,
    description: c.description,
    price: Math.round(c.price * 100),
  }));

  const config = await getPricingConfig();
  const effectiveHourlyRate = input.hourlyRateOverride ?? config.hourlyRate;
  const laborCents = services.reduce(
    (sum, s) => sum + Math.round((s.laborHours ?? 0) * effectiveHourlyRate),
    0,
  );

  const feeLineItems = buildFeeItems(config, {
    isRush: input.isRush,
    isAfterHours: input.isAfterHours,
    isWeekend: input.isWeekend,
    isSunday: input.isSunday,
    isHoliday: input.isHoliday,
    isEarlyMorning: input.isEarlyMorning,
    travelMiles: input.travelMiles,
    totalLaborCents: laborCents,
    services,
  });

  // Tech-prep enrichment (internal, best-effort): pull tools/difficulty/HV-safety
  // from the repair_jobs catalog for any service that carried a jobSlug, so the
  // shop's assigned mobile tech knows what to bring. Never blocks order creation.
  const techPrepBySlug = new Map<string, RepairTechPrep>();
  const jobSlugs = services
    .map((s) => s.jobSlug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (jobSlugs.length > 0) {
    try {
      for (const j of await getRepairJobs(jobSlugs)) {
        techPrepBySlug.set(j.slug, {
          difficulty: j.difficulty,
          tools: j.tools,
          typicalParts: j.typicalParts,
          hvSafety: j.hvSafety,
          likelySizes: j.likelySizes,
          notes: j.notes,
        });
      }
    } catch {
      // enrichment is non-critical — proceed without it
    }
  }

  const items: OrderItem[] = [
    ...serviceLineItems.map((li, i) => {
      const slug = services[i]?.jobSlug;
      return toOrderItem(li, "labor", {
        laborHours: services[i]?.laborHours,
        techPrep: slug ? techPrepBySlug.get(slug) : undefined,
      });
    }),
    ...customLineItems.map((li) => toOrderItem(li, "labor")),
    ...feeLineItems.map((li) => toOrderItem(li, "fee")),
  ];

  const subtotalBeforeDiscount = items.reduce((sum, i) => sum + i.totalCents, 0);
  const discount = calculateDiscount(
    config,
    subtotalBeforeDiscount,
    input.discountType,
    services.length,
  );

  if (discount && discount.amount > 0) {
    items.push({
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

  let subtotal = items.reduce((sum, i) => sum + i.totalCents, 0);
  if (subtotal < config.minimumServiceFee) {
    subtotal = config.minimumServiceFee;
  }

  return {
    items,
    subtotal,
    rangeLow: Math.round(subtotal * 0.9),
    rangeHigh: Math.round(subtotal * 1.1),
  };
}

// ---------------------------------------------------------------------------
// create_order — INSERT new draft, or UPDATE existing draft/revised/estimated
// ---------------------------------------------------------------------------

export const createOrderTool = {
  name: "create_order",
  description:
    "Create a new draft order, OR update an existing draft/revised/estimated order in place. " +
    "This is the only tool for full-pricing-engine writes — it auto-applies disposal/hazmat/" +
    "battery/travel/time surcharges and discounts.\n\n" +
    "USAGE: omit `orderId` to create a new draft. Pass `orderId` to revise an order you already " +
    "created in this conversation — the row is updated in place (NOT duplicated). Updating an " +
    "'estimated' order automatically flips it back to 'revised' so the shop re-reviews.\n\n" +
    "DO NOT call this tool again with the same vehicle in the same conversation without passing " +
    "the orderId from your previous call. For incremental tweaks (add one item, fix the customer's " +
    "phone), prefer `update_order_items` / `update_order` — they're cheaper and don't re-run the " +
    "full pricing engine.",
  schema: z.object({
    orderId: z
      .number()
      .int()
      .optional()
      .describe(
        "Order ID to UPDATE in place (must be in draft/revised/estimated). Omit to INSERT new draft.",
      ),
    customerId: z
      .number()
      .int()
      .optional()
      .describe(
        "Existing customer ID. Customer chats: omit (auth context wins). Staff: pass for known customers.",
      ),
    customerInfo: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        serviceZip: z.string().optional().describe(
          "Customer 5-digit US ZIP for the service location. Enough to price + route the " +
            "estimate; the full street address is collected later at booking.",
        ),
      })
      .optional()
      .describe(
        "Two roles: (a) Staff walk-in fallback — name/email/phone/address to find-or-create a guest customer when no customerId is known. (b) Customer chat — supply phone or address/serviceZip here whenever the customer mentions a fresh value or the profile is blank; phone/address backfill the customers row only when previously empty (existing profile values are NEVER overwritten), and ALWAYS take precedence on this order's contactPhone/contactAddress snapshot. Customer chat REQUIRES that, after fallback to the customer profile, phone AND (address OR serviceZip) are resolvable — otherwise the call fails with missingFields. A 5-digit ZIP is enough for the estimate; the full street address is collected at booking.",
      ),
    vehicle: z
      .object({
        year: z.number().describe("Vehicle year, e.g. 2015"),
        make: z.string().describe("Vehicle make, e.g. 'Honda'"),
        model: z.string().describe("Vehicle model, e.g. 'Civic'"),
      })
      .describe("Vehicle the order is for"),
    services: z
      .array(
        z.object({
          name: z.string().describe("Service name"),
          description: z.string().describe("Brief description"),
          laborHours: z
            .number()
            .optional()
            .describe("Labor hours from OLP lookup, or your best estimate"),
          partsCost: z
            .number()
            .optional()
            .describe("Estimated parts cost in dollars"),
          involvesHazmat: z
            .boolean()
            .default(false)
            .describe("True for oil/coolant/brake-fluid/etc. services"),
          tireCount: z
            .number()
            .optional()
            .describe("Number of tires being disposed"),
          involvesBattery: z
            .boolean()
            .default(false)
            .describe("True if service involves battery replacement"),
          customerSuppliedParts: z
            .boolean()
            .default(false)
            .describe(
              "Customer is bringing their own parts. Skips parts pricing; bills labor only.",
            ),
          jobSlug: z
            .string()
            .optional()
            .describe(
              "The `slug` for this job from lookup_labor_time results. Pass it through so the shop gets tools/difficulty/HV-safety for tech prep (internal — never shown to the customer).",
            ),
        }),
      )
      .describe("Services to include in the order"),
    customItems: z
      .array(
        z.object({
          name: z.string().describe("Item name (e.g. 'Diagnostic Fee')"),
          description: z.string().describe("Brief description"),
          price: z.number().describe("Price in dollars"),
        }),
      )
      .optional()
      .describe("Flat-rate items that bypass the labor/parts engine"),
    notes: z.string().optional().describe("Order notes"),
    accessInstructions: z
      .string()
      .nullish()
      .describe(
        "Mobile-mechanic access notes: gate code, parking spot, ring buzzer at unit X, dog in yard, etc. Customer-supplied. Omit if customer has nothing to add. On UPDATE, pass null to clear an existing note.",
      ),
    symptomDescription: z
      .string()
      .nullish()
      .describe(
        "For repair/diagnostic services: the customer's description of how the problem manifests — duration, frequency, conditions ('grinding when braking from highway speed', 'starts only after sitting overnight'). Skip for routine maintenance (oil change, rotation). Omit if not applicable. On UPDATE, pass null to clear an existing note.",
      ),
    validDays: z
      .number()
      .default(14)
      .describe("Days until the order's share token expires"),

    // Scheduling-related fee flags
    isRush: z.boolean().default(false),
    isAfterHours: z.boolean().default(false),
    isEarlyMorning: z.boolean().default(false),
    isWeekend: z.boolean().default(false),
    isSunday: z.boolean().default(false),
    isHoliday: z.boolean().default(false),

    travelMiles: z
      .number()
      .optional()
      .describe("Distance to customer in miles (first 15 free, then $1/mi)"),

    discountType: discountEnum.optional(),
  }),
  execute: async (
    params: {
      orderId?: number;
      customerId?: number;
      customerInfo?: CustomerInfoInput;
      vehicle: { year: number; make: string; model: string };
      services: ServiceInput[];
      customItems?: { name: string; description: string; price: number }[];
      notes?: string;
      accessInstructions?: string | null;
      symptomDescription?: string | null;
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
    ctx: ToolContext | undefined,
  ) => {
    // Customer-side guard: drop the modifier knobs a customer could try to
    // jailbreak the agent into applying (flat-rate items, discounts, time/
    // travel surcharges). Labor hours and parts cost still come from the
    // LLM after it calls lookup_labor_time / lookup_parts_price — the order
    // skill's anti-jailbreak section forbids fabricated values.
    const isCustomerSide = customerAgentActor(ctx) != null;
    if (isCustomerSide) {
      params = {
        ...params,
        customItems: undefined,
        discountType: undefined,
        isRush: false,
        isAfterHours: false,
        isEarlyMorning: false,
        isWeekend: false,
        isSunday: false,
        isHoliday: false,
        travelMiles: undefined,
      };
    }

    const vehicleInfo = {
      year: String(params.vehicle.year),
      make: params.vehicle.make,
      model: params.vehicle.model,
    };

    // ─────────────────────────────────────────────────────────────────
    // UPDATE path — orderId provided. Routes through the harness's
    // patchItems so status/events/notifications all flow through the
    // single source of truth. The pricing engine (priceServices above)
    // applies a minimum-service-fee floor that items.reduce() wouldn't
    // capture — pass subtotal as `subtotalCentsOverride` to preserve it.
    //
    // We also call resolveCustomer here even on UPDATE so the customers
    // profile gets the same blank-only backfill behavior the INSERT path
    // gives it (e.g. customer adds a phone mid-revision and we save it
    // for next time). The freshly-supplied customerInfo also wins on the
    // order's contact snapshot — if a customer corrects their phone or
    // service address inside one chat, the order row needs to follow.
    //
    // Per-shop labor rate: fetch the existing order's shopId so revisions
    // price consistently with the shop that originally captured the order.
    // We do NOT re-route on UPDATE — the shopId is locked at INSERT time.
    // ─────────────────────────────────────────────────────────────────
    if (params.orderId !== undefined) {
      // Ownership pre-flight (cross-tenant WRITE — top priority). A customer
      // may only revise their own order; staff only an order in their shop;
      // owner all-shops is read-only (canWrite false → rejected). Return the
      // same "not found" shape so existence is not leaked.
      const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
      if (!canWrite(ctxAccess) || !(await orderAccessible(params.orderId, ctxAccess))) {
        return toolResult({ success: false, error: "Order not found" });
      }

      // Look up the existing order's shopId for consistent re-pricing.
      const [existingOrder] = await db
        .select({ shopId: schema.orders.shopId })
        .from(schema.orders)
        .where(eq(schema.orders.id, params.orderId))
        .limit(1);
      const existingShopId = existingOrder?.shopId ?? null;
      const updateShopRate = existingShopId
        ? (await shopHourlyRate(existingShopId) ?? undefined)
        : undefined;

      // Run pricing with the shop's rate (falls back to global if null).
      const { items, subtotal, rangeLow, rangeHigh } = await priceServices({
        ...params,
        vehicle: params.vehicle,
        hourlyRateOverride: updateShopRate,
      });

      const actor = customerAgentActor(ctx) ?? staffAgentActor(ctx);
      await resolveCustomer(
        ctx?.customerId,
        params.customerId,
        params.customerInfo,
        ctxAccess,
      );
      const phoneIn = clean(params.customerInfo?.phone);
      const addressIn = clean(params.customerInfo?.address);
      const result = await patchItems(
        params.orderId,
        {
          items,
          notes: params.notes ?? undefined,
          vehicleInfo,
          accessInstructions: params.accessInstructions !== undefined
            ? (clean(params.accessInstructions) ?? null)
            : undefined,
          symptomDescription: params.symptomDescription !== undefined
            ? (clean(params.symptomDescription) ?? null)
            : undefined,
          // Forward only when the agent supplied a non-empty value —
          // undefined leaves the snapshot unchanged. We never overwrite
          // an existing snapshot with a missing customerInfo field.
          contactPhone: phoneIn,
          contactAddress: addressIn,
        },
        actor,
        {
          subtotalCentsOverride: subtotal,
          metadata: {
            source: "create_order_update",
            itemCount: items.length,
          },
        },
      );

      return toolResultFromOrderState(result, (row) => ({
        action: "updated",
        orderId: row.id,
        status: row.status,
        version: row.revisionNumber,
        vehicle: `${params.vehicle.year} ${params.vehicle.make} ${params.vehicle.model}`,
        items: items.map((i) => ({
          // id is the stable itemId — update_order_items targets line items by
          // it. Without it the agent can't edit/remove existing items.
          id: i.id,
          name: i.name,
          description: i.description ?? null,
          unitPriceCents: i.unitPriceCents,
          totalCents: i.totalCents,
          quantity: i.quantity,
          category: i.category,
        })),
        subtotal: subtotal / 100,
        priceRange: `$${(rangeLow / 100).toFixed(2)} - $${(rangeHigh / 100).toFixed(2)}`,
        note: row.status === "revised"
          ? "Order was already sent to customer — flipped back to 'revised'. Shop must re-send."
          : "Order updated in place.",
      }));
    }

    // ─────────────────────────────────────────────────────────────────
    // INSERT path — new draft
    // ─────────────────────────────────────────────────────────────────

    // 0. Cross-tenant WRITE gate (top priority — mirror of the UPDATE branch).
    //    A customer agent always passes (ctx.customerId set); staff passes only
    //    with a concrete shop bound; an owner with no shop selected
    //    (ctx.shopId === OWNER_ALL_SHOPS) and the no-context case are rejected.
    const insertAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(insertAccess)) {
      return toolResult({ success: false, error: "Select a shop before creating an order." });
    }

    // 1. Address from the agent's input (before customer resolution) —
    //    this is the service address for the NEW order. Geocoding the address
    //    populates the order's locationLat/Lng regardless of which shop owns it.
    const addressIn = clean(params.customerInfo?.address) ?? null;
    // 1b. ZIP fallback — customer chat may supply only a 5-digit ZIP (the
    //     full address is collected later at booking). Used for routing/coords
    //     when no address is available, and stored as `location` if that's all
    //     we have.
    const serviceZipIn = clean(params.customerInfo?.serviceZip) ?? null;

    // 2. Branch on caller. The shop-selection rule differs:
    //    - Customer agent (access.customerId != null): the order routes to the
    //      nearest shop by service address (intended cross-shop routing). The
    //      customer is resolved from ctx.customerId — a guest insert never
    //      reaches the address-routed branch.
    //    - Staff agent (access.customerId == null): canWrite guarantees a
    //      concrete access.shopId. The order — AND any guest customer it
    //      creates — MUST be the staff member's own shop, never the routed one.
    const isCustomerAgent = insertAccess.customerId != null;

    // 3. Resolve (or create) the customer. The guest-create defaultShopId is
    //    the staff member's own shop (unused on the customer path, where the
    //    id resolves and no guest is created) so a walk-in is never stamped
    //    with a foreign (address-routed) shop.
    const customer = await resolveCustomer(
      ctx?.customerId,
      params.customerId,
      params.customerInfo,
      insertAccess,
      insertAccess.shopId, // concrete for staff; ignored for customer
    );

    // 4. Per-order contact snapshot — what THIS order will carry. The agent's
    //    freshly-supplied customerInfo wins (it's the most recent intent), and
    //    we fall back to the customer profile when the agent didn't pass a
    //    value. resolveCustomer has already backfilled blank profile fields
    //    from customerInfo, so customer.phone / customer.address reflect any
    //    newly-stored defaults.
    const orderPhone = clean(params.customerInfo?.phone) ?? customer?.phone ?? null;
    const orderAddress = addressIn ?? customer?.address ?? null;

    // 5. Resolve the order's shop + coordinates (best-effort; never gates
    //    creation). Customer: route by the order address so shop + coords track
    //    the job's location. Staff: shop is forced to the staff member's own
    //    shop; geocode the order address only to populate coords.
    let orderShopId: string;
    let coords: Coords | null;
    let routingNote: string | null = null;
    if (isCustomerAgent) {
      const routed = await routeOrderToShop(orderAddress, serviceZipIn);
      orderShopId = routed.shopId; // nearest shop wins
      coords = routed.coords;
      // Coverage flag: surface a routing miss for staff review instead of
      // silently leaving the order on the primary-shop fallback. ponytail:
      // adminNotes is the cheapest visible channel (renders in the order
      // detail Notes card); upgrade to a list badge if the queue needs it.
      routingNote = routingReviewNote(routed);
    } else {
      orderShopId = insertAccess.shopId as string; // staff's own shop (per canWrite)
      coords = orderAddress ? await geocodeAddress(orderAddress) : null;
    }
    const locationLat = coords ? String(coords.lat) : null;
    const locationLng = coords ? String(coords.lng) : null;

    // 6. Per-shop labor rate. Falls back to undefined (→ global rate) when
    //    the shop row is missing or its laborRateCents column is null.
    const insertShopRate = await shopHourlyRate(orderShopId) ?? undefined;

    // 7. Run the pricing engine with the shop's rate.
    const { items, subtotal, rangeLow, rangeHigh } = await priceServices({
      ...params,
      vehicle: params.vehicle,
      hourlyRateOverride: insertShopRate,
    });

    // Customer-side requirement: after fallback to the profile, phone AND
    // (address OR serviceZip) must resolve. The agent must collect whatever
    // is missing and pass via customerInfo. A ZIP is enough for the estimate —
    // the full street address is collected later at booking. Staff side has
    // no such restriction — walk-ins and orphan orders are still allowed.
    if (isCustomerSide) {
      const missing: string[] = [];
      if (!orderPhone) missing.push("phone");
      if (!orderAddress && !serviceZipIn) missing.push("service ZIP (or full address)");
      if (missing.length > 0) {
        const fieldList = missing.join(" and ");
        return toolResult({
          success: false,
          error: `Cannot create the order yet — missing ${fieldList}. Ask the customer for ` +
            `their ${fieldList}. A 5-digit ZIP is enough for the estimate; the full street ` +
            `address is collected when they book. Then call create_order again with customerInfo.`,
          missingFields: missing,
        });
      }
    }

    // Schema invariant: orders.customer_id is NOT NULL. resolveCustomer
    // returns null when the staff agent neither resolved a customerId nor
    // provided enough customerInfo to find-or-create one — surface this as
    // a tool error instead of letting it surface as a NOT NULL violation
    // at the DB layer.
    if (!customer) {
      return toolResult({
        success: false,
        error: "Cannot create the order — no customer was identified. Pass either " +
          "customerId (for an existing customer) or customerInfo with at " +
          "least one of name / email / phone so I can find or create one.",
      });
    }

    const shareToken = nanoid(32);
    const validDays = params.validDays ?? 14;
    const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

    const accessInstructions = clean(params.accessInstructions) ?? null;
    const symptomDescription = clean(params.symptomDescription) ?? null;

    // Loop front-half: when the customer described a symptom, run the brain to
    // produce + store a prediction and stamp its id on the order. Best-effort —
    // a diagnosis failure (or the fixo_predictions table not yet migrated) must
    // never block order creation; we just skip the link, so this stays safe to
    // deploy ahead of migration 0027. The matching outcome is reported back when
    // the mechanic records the confirmed diagnosis (see recordOutcome).
    let fixoPredictionId: string | null = null;
    if (symptomDescription) {
      try {
        fixoPredictionId = await openPrediction({
          vehicle: vehicleInfo,
          symptom: symptomDescription,
        });
        // Fire-and-forget: the expert diagnosis (~5s agent run) must not block order create.
        // ponytail: if a worker/queue ever exists, move this there; for now a detached promise is fine.
        void fillPrediction(fixoPredictionId, { vehicle: vehicleInfo, symptom: symptomDescription })
          .catch((err) => console.error("fillPrediction failed:", String(err)));
      } catch (err) {
        console.error("openPrediction failed during order create:", String(err));
      }
    }

    // Estimate-side calibration: attach the priced estimate (from the shared
    // pricing engine above) to the prediction so estimate-vs-actual can be
    // scored later. Fire-and-forget — never blocks order creation.
    if (fixoPredictionId) {
      recordEstimate({
        predictionId: fixoPredictionId,
        items,
        subtotalCents: subtotal,
        priceRangeLowCents: rangeLow,
        priceRangeHighCents: rangeHigh,
      }).catch((err) => {
        console.error("recordEstimate failed during order create:", String(err));
      });
    }

    const order = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.orders)
        .values({
          shopId: orderShopId,
          customerId: customer.id,
          status: "draft",
          statusHistory: [
            { status: "draft", timestamp: new Date().toISOString(), actor: "agent" },
          ],
          items,
          notes: params.notes ?? null,
          adminNotes: routingNote,
          subtotalCents: subtotal,
          priceRangeLowCents: rangeLow,
          priceRangeHighCents: rangeHigh,
          vehicleInfo,
          // Only reference the column when set, so order creation still works
          // before migration 0027 adds it (the link just stays empty).
          ...(fixoPredictionId ? { fixoPredictionId } : {}),
          accessInstructions,
          shareToken,
          validDays,
          expiresAt,
          contactName: customer.name ?? null,
          contactEmail: customer.email ?? null,
          contactPhone: orderPhone,
          // location is the booking/scheduling display field: the precise
          // address when we have one, else the bare ZIP so mechanic/portal
          // views still show a service area. contactAddress stays the
          // precise per-order snapshot only — null when the customer gave
          // just a ZIP (the full address is collected at booking).
          location: orderAddress ?? serviceZipIn,
          contactAddress: orderAddress,
          locationLat,
          locationLng,
        })
        .returning();

      // Intake is a child row — only insert if the customer actually
      // submitted a symptom narrative. Walk-in / direct admin paths leave
      // it empty.
      if (symptomDescription) {
        await upsertOrderIntake(row.id, { symptomDescription }, tx);
      }

      await tx.insert(schema.orderEvents).values({
        orderId: row.id,
        eventType: "status_change",
        fromStatus: null,
        toStatus: "draft",
        actor: "agent",
        metadata: {
          source: "create_order_insert",
          vehicleInfo,
          itemCount: items.length,
        },
      });

      return row;
    });

    // First-order claiming: a customer's home shop is stamped by signup/chat
    // defaults, not geography. On their FIRST order, adopt that order's shop so
    // the customer lands in the right shop's book. System cross-shop write →
    // dbAdmin (the RLS customer policy would block moving a row between shops).
    // Best-effort: never break order creation.
    if (isCustomerAgent && customer) {
      try {
        const prior = await dbAdmin
          .select({ id: schema.orders.id })
          .from(schema.orders)
          .where(and(eq(schema.orders.customerId, customer.id), ne(schema.orders.id, order.id)))
          .limit(1);
        if (shouldClaimShop(prior.length > 0, customer.shopId, orderShopId)) {
          await dbAdmin.update(schema.customers)
            .set({ shopId: orderShopId })
            .where(eq(schema.customers.id, customer.id));
        }
      } catch (e) {
        console.error("first-order claim failed:", { customerId: customer.id, err: String(e) });
      }
    }

    return toolResult({
      success: true,
      action: "created",
      orderId: order.id,
      status: "draft",
      pendingReview: true,
      vehicle: `${params.vehicle.year} ${params.vehicle.make} ${params.vehicle.model}`,
      customerName: customer?.name ?? null,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description ?? null,
        unitPriceCents: i.unitPriceCents,
        totalCents: i.totalCents,
        quantity: i.quantity,
        category: i.category,
      })),
      subtotal: subtotal / 100,
      priceRange: `$${(rangeLow / 100).toFixed(2)} - $${(rangeHigh / 100).toFixed(2)}`,
      expiresAt,
      note: "Draft order saved for shop team review. To revise this same order later in the " +
        "conversation, call create_order again with this orderId — do NOT create a new one.",
    });
  },
};

// ---------------------------------------------------------------------------
// get_order — read an order by ID
// ---------------------------------------------------------------------------

export const getOrderTool = {
  name: "get_order",
  description: "Retrieve an existing order by ID. Returns status, items, totals, and metadata.",
  schema: z.object({
    orderId: z.number().int().describe("Order ID"),
  }),
  execute: async (params: { orderId: number }, ctx: ToolContext | undefined) => {
    // Ownership pre-flight: customer sees only their own orders; staff only
    // their shop's; owner all-shops may read any; no context denies. Return
    // the same "not found" shape on a denied read so existence isn't leaked.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!(await orderAccessible(params.orderId, ctxAccess))) {
      return toolResult({ found: false, message: "Order not found" });
    }

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, params.orderId))
      .limit(1);

    if (!order) {
      return toolResult({ found: false, message: "Order not found" });
    }

    const isExpired = order.expiresAt ? new Date() > order.expiresAt : false;
    const items = (order.items ?? []) as OrderItem[];

    return toolResult({
      found: true,
      order: {
        id: order.id,
        status: order.status,
        items: items.map((i) => ({
          // id is the stable itemId — update_order_items targets line items by
          // it. Without it the agent can't edit/remove existing items.
          id: i.id,
          name: i.name,
          description: i.description ?? null,
          unitPriceCents: i.unitPriceCents,
          totalCents: i.totalCents,
          quantity: i.quantity,
          category: i.category,
        })),
        subtotal: (order.subtotalCents ?? 0) / 100,
        priceRange: order.priceRangeLowCents && order.priceRangeHighCents
          ? `$${(order.priceRangeLowCents / 100).toFixed(2)} - $${
            (order.priceRangeHighCents / 100).toFixed(2)
          }`
          : null,
        notes: order.notes,
        vehicleInfo: order.vehicleInfo,
        expiresAt: order.expiresAt,
        isExpired,
        revisionNumber: order.revisionNumber,
        downloadUrl: `/api/orders/${order.id}/pdf`,
        shareUrl: order.shareToken ? `/api/orders/${order.id}/pdf?token=${order.shareToken}` : null,
      },
    });
  },
};

export const orderTools = [createOrderTool, getOrderTool];
