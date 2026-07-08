import { z } from "zod";
import type { OrderStatus } from "@hmls/shared/order/status";

// ---------------------------------------------------------------------------
// Shared: order status enum (canonical list — single definition for this
// module; reused wherever a status field appears)
// ---------------------------------------------------------------------------

export const orderStatusEnum = z.enum([
  "draft",
  "estimated",
  "revised",
  "approved",
  "declined",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
]) satisfies z.ZodType<OrderStatus>;

// ---------------------------------------------------------------------------
// GET /orders — query string
// ---------------------------------------------------------------------------

export const listOrdersQuery = z.object({
  status: orderStatusEnum.optional(),
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

export const transitionOrderInput = z.object({
  status: orderStatusEnum,
  notes: z.string().optional(),
  cancellationReason: z.string().optional(),
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
  method: z.enum(["cash", "card", "check", "venmo", "zelle", "stripe", "other"]),
  reference: z.string().optional(),
  paidAt: z.string().optional(),
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
