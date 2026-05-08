import { z } from "zod";

// ---------------------------------------------------------------------------
// POST / — create a new mechanic
// ---------------------------------------------------------------------------

export const createMechanicInput = z.object({
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  timezone: z.string().optional(),
  isActive: z.boolean().optional(),
  authUserId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// PATCH /:id — edit mechanic profile fields
// ---------------------------------------------------------------------------

export const updateMechanicInput = z.object({
  name: z.string().optional(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  timezone: z.string().optional(),
  isActive: z.boolean().optional(),
  authUserId: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// PUT /:id/availability — replace weekly schedule atomically
// ---------------------------------------------------------------------------

export const availabilityRowInput = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
});

export const setAvailabilityInput = z.object({
  availability: z.array(availabilityRowInput),
});

// ---------------------------------------------------------------------------
// GET /:id/overrides — query string
// ---------------------------------------------------------------------------

export const listOverridesQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /:id/overrides — upsert a schedule override
// ---------------------------------------------------------------------------

export const createOverrideInput = z.object({
  overrideDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isAvailable: z.boolean(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /:id/orders — query string (date range filter)
// ---------------------------------------------------------------------------

export const listMechanicOrdersQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /orders/:orderId/assign — assign / reassign provider on an order
// ---------------------------------------------------------------------------

export const assignProviderInput = z.object({
  providerId: z.number().int().positive(),
  force: z.boolean().optional(),
});
