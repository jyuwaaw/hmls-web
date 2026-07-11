import { z } from "zod";
import {
  AUTHORIZATION_CHANNELS,
  canonicalizeStatus,
  type OrderAuthorization,
  type OrderStatus,
  PAYMENT_METHODS,
} from "@hmls/shared/order/status";

// ---------------------------------------------------------------------------
// Shared: order status enums. `orderStatusEnum` is the canonical 7-state
// list (use for OUTPUT shapes). `orderStatusInput` additionally accepts the
// legacy 'scheduled' / 'revised' labels during the 9→7 deploy→remap window
// and maps them through canonicalizeStatus (use for INPUT filters /
// transition targets). Once old clients are gone the legacy entries can be
// dropped — they are harmless until then.
// ---------------------------------------------------------------------------

export const orderStatusEnum = z.enum([
  "draft",
  "estimated",
  "approved",
  "declined",
  "in_progress",
  "completed",
  "cancelled",
]) satisfies z.ZodType<OrderStatus>;

export const orderStatusInput = z
  .enum([...orderStatusEnum.options, "scheduled", "revised"])
  .transform((s): OrderStatus => canonicalizeStatus(s));

// ---------------------------------------------------------------------------
// GET /orders — query string
// ---------------------------------------------------------------------------

export const listOrdersQuery = z.object({
  status: orderStatusInput.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// POST /orders — create a new draft order
// ---------------------------------------------------------------------------

export const orderItemInput = z.object({
  description: z.string(),
  labor_hours: z.number().nonnegative().optional(),
  parts_cost: z.number().nonnegative().optional(),
});

export const createOrderInput = z.object({
  customer_id: z.number().int().positive(),
  vehicle_year: z.number().int().optional(),
  vehicle_make: z.string().optional(),
  vehicle_model: z.string().optional(),
  description: z.string().optional(),
  items: z.array(orderItemInput).optional(),
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id — edit order fields
// ---------------------------------------------------------------------------

/** Full OrderItem shape (mirrors apps/agent/src/db schema OrderItem type).
 *  The route accepts the full array from the client as-is; the harness
 *  validates semantics. Keeping this loose (passthrough-ish) avoids
 *  maintaining a duplicate of the DB type here. */
export const orderItemPatchInput = z.record(z.string(), z.unknown());

/** Canonical contact-method list — single definition, mirrors the
 *  contact_method pg enum in db/schema.ts. Reuse wherever a preferred-contact
 *  field appears; never inline the literals. */
export const CONTACT_METHODS = ["text", "call", "email"] as const;
export const contactMethodInput = z.enum(CONTACT_METHODS);
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const updateOrderInput = z.object({
  items: z.array(orderItemPatchInput).optional(),
  notes: z.string().nullish(),
  confirmedDiagnosis: z.string().nullish(),
  vehicleInfo: z.record(z.string(), z.unknown()).nullish(),
  validDays: z.number().int().positive().optional(),
  expiresAt: z.string().nullish(),
  contact_name: z.string().nullish(),
  contact_email: z.string().nullish(),
  contact_phone: z.string().nullish(),
  contact_address: z.string().nullish(),
  contact_preferred: contactMethodInput.nullish(),
});

// ---------------------------------------------------------------------------
// POST /orders/:id/contact-log — record a manual customer outreach
// ---------------------------------------------------------------------------

export const logContactInput = z.object({
  method: contactMethodInput,
  note: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// POST /orders/:id/schedule — set / reschedule appointment
// ---------------------------------------------------------------------------

export const scheduleOrderInput = z.object({
  scheduledAt: z.string(),
  durationMinutes: z.number().int().positive(),
  location: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id/status — generic status transition
// ---------------------------------------------------------------------------

/** Customer-authorization evidence for fenced transitions (any →approved,
 *  including the draft→approved walk-in shortcut). One contract shared by
 *  web, gateway, and agent tools — see requiresCustomerAuthorization in
 *  order/status. */
export const orderAuthorizationInput = z.object({
  channel: z.enum(AUTHORIZATION_CHANNELS),
  note: z.string().max(500).optional(),
}) satisfies z.ZodType<OrderAuthorization>;

export const transitionOrderInput = z.object({
  status: orderStatusInput,
  notes: z.string().optional(),
  cancellationReason: z.string().optional(),
  authorization: orderAuthorizationInput.optional(),
});

// ---------------------------------------------------------------------------
// POST /orders/:id/events — add annotation note
// ---------------------------------------------------------------------------

export const addOrderNoteInput = z.object({
  note: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// POST /orders/:id/payment — record manual payment
// ---------------------------------------------------------------------------

export const recordPaymentInput = z.object({
  amountCents: z.number().int().positive(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().optional(),
  // Must be a real ISO 8601 timestamp — a bare z.string() lets a malformed
  // value reach `new Date(paidAt)` as an Invalid Date, which then throws on
  // Postgres serialization inside the money write.
  paidAt: z.string().datetime({ offset: true }).optional(),
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id/notes — update admin notes
// ---------------------------------------------------------------------------

export const updateAdminNotesInput = z.object({
  notes: z.string(),
});

// ---------------------------------------------------------------------------
// GET /orders/:id/pdf — query string (public, token-based)
// ---------------------------------------------------------------------------

export const orderPdfQuery = z.object({
  token: z.string().optional(),
});
