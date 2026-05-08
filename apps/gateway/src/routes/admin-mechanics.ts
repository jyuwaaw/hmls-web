import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, between, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@hmls/agent/db";
import { type Actor, assignProvider } from "@hmls/agent/order-state";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import {
  availableMinutesForWeek,
  bookedMinutesForWeek,
  computeUtilization,
  endOfWeek,
  isOnJobNow,
} from "../lib/mechanic-stats.ts";
import {
  assignProviderInput,
  createMechanicInput,
  createOverrideInput,
  listMechanicOrdersQuery,
  listOverridesQuery,
  setAvailabilityInput,
  updateMechanicInput,
} from "@hmls/shared/api/contracts/admin-mechanics";
import type {
  OrderRow,
  ProviderAvailabilityRow,
  ProviderRow,
  ProviderScheduleOverrideRow,
} from "@hmls/shared/db/types";

type ApiError = { error: { code: string; message: string } };

/** Provider row with aggregate mechanic stats appended. */
type ProviderWithStats = ProviderRow & {
  weekUtilization: number | null;
  isOnJobNow: boolean;
  upcomingBookingsCount: number;
  earnings30d: number;
  nextBookingAt: Date | null;
};

/** Order row joined with customer contact fields. */
type OrderWithCustomer = OrderRow & {
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
};

function adminActor(email: string | null | undefined): Actor {
  return { kind: "admin", email: email ?? "admin" };
}

const adminMechanics = new Hono<AdminEnv>();

adminMechanics.use("*", requireAdmin);

// GET / — list mechanics with aggregate stats
adminMechanics.get("/", async (c) => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 14);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const providers = await db
    .select()
    .from(schema.providers)
    .orderBy(desc(schema.providers.isActive), asc(schema.providers.name));

  if (providers.length === 0) return c.json<ProviderWithStats[]>([]);

  const providerIds = providers.map((p) => p.id);

  // All scheduling queries target `orders` directly now. An order is "active
  // on a mechanic's schedule" when it has a providerId + scheduledAt and its
  // status is not cancelled/declined.
  const activeStatusSql = sql`${schema.orders.status} NOT IN ('cancelled', 'declined')`;

  const [
    availability,
    overrides,
    weekBookings,
    nowBookings,
    paidOrders,
    upcomingCounts,
    nextBookings,
  ] = await Promise.all([
    db
      .select()
      .from(schema.providerAvailability)
      .where(inArray(schema.providerAvailability.providerId, providerIds)),
    db
      .select()
      .from(schema.providerScheduleOverrides)
      .where(
        inArray(schema.providerScheduleOverrides.providerId, providerIds),
      ),
    db
      .select({
        providerId: schema.orders.providerId,
        scheduledAt: schema.orders.scheduledAt,
        durationMinutes: schema.orders.durationMinutes,
        status: schema.orders.status,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, providerIds),
          gte(schema.orders.scheduledAt, weekStart),
          activeStatusSql,
        ),
      ),
    // Snapshot orders around "now" (±24h) for isOnJobNow.
    db
      .select({
        providerId: schema.orders.providerId,
        scheduledAt: schema.orders.scheduledAt,
        durationMinutes: schema.orders.durationMinutes,
        status: schema.orders.status,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, providerIds),
          between(
            schema.orders.scheduledAt,
            new Date(now.getTime() - 24 * 60 * 60 * 1000),
            new Date(now.getTime() + 24 * 60 * 60 * 1000),
          ),
          activeStatusSql,
        ),
      ),
    // Earnings 30d: completed orders assigned to these providers.
    db
      .select({
        providerId: schema.orders.providerId,
        amountCents: sql<
          number
        >`COALESCE(${schema.orders.paidAmountCents}, ${schema.orders.subtotalCents})`,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, providerIds),
          eq(schema.orders.status, "completed"),
          gte(schema.orders.createdAt, thirtyDaysAgo),
        ),
      ),
    db
      .select({
        providerId: schema.orders.providerId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, providerIds),
          gte(schema.orders.scheduledAt, now),
          lte(schema.orders.scheduledAt, endOfWeek(now)),
          sql`${schema.orders.status} IN ('scheduled', 'in_progress')`,
        ),
      )
      .groupBy(schema.orders.providerId),
    db
      .select({
        providerId: schema.orders.providerId,
        scheduledAt: sql<Date>`MIN(${schema.orders.scheduledAt})`,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, providerIds),
          gte(schema.orders.scheduledAt, now),
          sql`${schema.orders.status} IN ('scheduled', 'in_progress')`,
        ),
      )
      .groupBy(schema.orders.providerId),
  ]);

  const groupBy = <T extends { providerId: number | null }>(
    rows: T[],
  ): Map<number, T[]> => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      if (r.providerId == null) continue;
      const list = m.get(r.providerId) ?? [];
      list.push(r);
      m.set(r.providerId, list);
    }
    return m;
  };

  const availByProvider = groupBy(availability);
  const overridesByProvider = groupBy(overrides);
  const weekByProvider = groupBy(weekBookings);
  const nowByProvider = groupBy(nowBookings);

  const earningsByProvider = new Map<number, number>();
  for (const row of paidOrders) {
    if (row.providerId == null) continue;
    earningsByProvider.set(
      row.providerId,
      (earningsByProvider.get(row.providerId) ?? 0) + Number(row.amountCents),
    );
  }
  const upcomingCountByProvider = new Map<number, number>();
  for (const row of upcomingCounts) {
    if (row.providerId == null) continue;
    upcomingCountByProvider.set(row.providerId, row.count);
  }
  const nextByProvider = new Map<number, Date>();
  for (const row of nextBookings) {
    if (row.providerId == null) continue;
    nextByProvider.set(row.providerId, row.scheduledAt);
  }

  const result = providers.map((p) => {
    const avail = availByProvider.get(p.id) ?? [];
    const ovr = overridesByProvider.get(p.id) ?? [];
    const weekB = (weekByProvider.get(p.id) ?? [])
      .filter((b) => b.scheduledAt != null)
      .map((b) => ({
        scheduledAt: new Date(b.scheduledAt as Date | string),
        durationMinutes: b.durationMinutes ?? 60,
        status: b.status,
      }));
    const nowB = (nowByProvider.get(p.id) ?? [])
      .filter((b) => b.scheduledAt != null)
      .map((b) => ({
        scheduledAt: new Date(b.scheduledAt as Date | string),
        durationMinutes: b.durationMinutes ?? 60,
        status: b.status,
      }));

    const availableMinutes = availableMinutesForWeek(avail, ovr, now);
    const bookedMinutes = bookedMinutesForWeek(weekB, now);
    return {
      ...p,
      weekUtilization: computeUtilization(availableMinutes, bookedMinutes),
      isOnJobNow: isOnJobNow(nowB, now),
      upcomingBookingsCount: upcomingCountByProvider.get(p.id) ?? 0,
      earnings30d: earningsByProvider.get(p.id) ?? 0,
      nextBookingAt: nextByProvider.get(p.id) ?? null,
    };
  });

  return c.json<ProviderWithStats[]>(result);
});

// POST / — create a new mechanic
adminMechanics.post("/", zValidator("json", createMechanicInput), async (c) => {
  const body = c.req.valid("json");

  const [created] = await db
    .insert(schema.providers)
    .values({
      name: body.name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      timezone: body.timezone ?? "America/Los_Angeles",
      isActive: body.isActive ?? true,
      authUserId: body.authUserId ?? null,
    })
    .returning();

  return c.json<ProviderRow>(created, 201);
});

// GET /:id — single mechanic
adminMechanics.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }

  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, id))
    .limit(1);

  if (!provider) {
    return c.json<ApiError>(
      { error: { code: "NOT_FOUND", message: "Mechanic not found" } },
      404,
    );
  }
  return c.json<ProviderRow>(provider);
});

// PATCH /:id — edit profile fields
adminMechanics.patch("/:id", zValidator("json", updateMechanicInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }

  const body = c.req.valid("json");

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.email !== undefined) updates.email = body.email;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  if (body.authUserId !== undefined) updates.authUserId = body.authUserId;

  if (Object.keys(updates).length === 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "No fields to update" } },
      400,
    );
  }

  const [updated] = await db
    .update(schema.providers)
    .set(updates)
    .where(eq(schema.providers.id, id))
    .returning();

  if (!updated) {
    return c.json<ApiError>(
      { error: { code: "NOT_FOUND", message: "Mechanic not found" } },
      404,
    );
  }
  return c.json<ProviderRow>(updated);
});

// DELETE /:id — soft delete (sets isActive=false). Bookings reference this
// row, so we never hard-delete.
adminMechanics.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }

  const [updated] = await db
    .update(schema.providers)
    .set({ isActive: false })
    .where(eq(schema.providers.id, id))
    .returning();

  if (!updated) {
    return c.json<ApiError>(
      { error: { code: "NOT_FOUND", message: "Mechanic not found" } },
      404,
    );
  }
  return c.json<{ success: true }>({ success: true });
});

// GET /:id/availability — read weekly hours
adminMechanics.get("/:id/availability", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }
  const rows = await db
    .select()
    .from(schema.providerAvailability)
    .where(eq(schema.providerAvailability.providerId, id))
    .orderBy(asc(schema.providerAvailability.dayOfWeek));
  return c.json<ProviderAvailabilityRow[]>(rows);
});

// PUT /:id/availability — replace weekly hours atomically
adminMechanics.put("/:id/availability", zValidator("json", setAvailabilityInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }

  const body = c.req.valid("json");

  // Business rule beyond shape: endTime must be after startTime
  for (const row of body.availability) {
    if (row.endTime <= row.startTime) {
      return c.json<ApiError>(
        {
          error: {
            code: "BAD_REQUEST",
            message: "endTime must be after startTime",
          },
        },
        400,
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.providerAvailability)
      .where(eq(schema.providerAvailability.providerId, id));
    if (body.availability.length > 0) {
      await tx.insert(schema.providerAvailability).values(
        body.availability.map((a) => ({ providerId: id, ...a })),
      );
    }
  });

  const rows = await db
    .select()
    .from(schema.providerAvailability)
    .where(eq(schema.providerAvailability.providerId, id))
    .orderBy(asc(schema.providerAvailability.dayOfWeek));
  return c.json<ProviderAvailabilityRow[]>(rows);
});

// GET /:id/overrides — read schedule overrides
adminMechanics.get("/:id/overrides", zValidator("query", listOverridesQuery), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }
  const { from, to } = c.req.valid("query");

  const conditions = [eq(schema.providerScheduleOverrides.providerId, id)];
  if (from) {
    conditions.push(gte(schema.providerScheduleOverrides.overrideDate, from));
  }
  if (to) {
    conditions.push(lte(schema.providerScheduleOverrides.overrideDate, to));
  }

  const rows = await db
    .select()
    .from(schema.providerScheduleOverrides)
    .where(and(...conditions))
    .orderBy(asc(schema.providerScheduleOverrides.overrideDate));
  return c.json<ProviderScheduleOverrideRow[]>(rows);
});

// POST /:id/overrides — upsert override (one per date)
adminMechanics.post("/:id/overrides", zValidator("json", createOverrideInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }

  const body = c.req.valid("json");

  // Business rule beyond shape: if isAvailable, times are required
  if (body.isAvailable && (!body.startTime || !body.endTime)) {
    return c.json<ApiError>(
      {
        error: {
          code: "BAD_REQUEST",
          message: "startTime and endTime required when isAvailable is true",
        },
      },
      400,
    );
  }

  await db
    .delete(schema.providerScheduleOverrides)
    .where(
      and(
        eq(schema.providerScheduleOverrides.providerId, id),
        eq(schema.providerScheduleOverrides.overrideDate, body.overrideDate),
      ),
    );

  const [created] = await db
    .insert(schema.providerScheduleOverrides)
    .values({
      providerId: id,
      overrideDate: body.overrideDate,
      isAvailable: body.isAvailable,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      reason: body.reason ?? null,
    })
    .returning();
  return c.json<ProviderScheduleOverrideRow>(created, 201);
});

// DELETE /:id/overrides/:overrideId — delete single override
adminMechanics.delete("/:id/overrides/:overrideId", async (c) => {
  const id = Number(c.req.param("id"));
  const overrideId = Number(c.req.param("overrideId"));
  if (
    !Number.isInteger(id) || id <= 0 ||
    !Number.isInteger(overrideId) || overrideId <= 0
  ) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid ID" } },
      400,
    );
  }

  const result = await db
    .delete(schema.providerScheduleOverrides)
    .where(
      and(
        eq(schema.providerScheduleOverrides.id, overrideId),
        eq(schema.providerScheduleOverrides.providerId, id),
      ),
    )
    .returning({ id: schema.providerScheduleOverrides.id });

  if (result.length === 0) {
    return c.json<ApiError>(
      { error: { code: "NOT_FOUND", message: "Override not found" } },
      404,
    );
  }
  return c.json<{ ok: true }>({ ok: true });
});

// GET /:id/orders — scheduled orders assigned to this mechanic, with customer join
adminMechanics.get("/:id/orders", zValidator("query", listMechanicOrdersQuery), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid mechanic ID" } },
      400,
    );
  }
  const { from, to } = c.req.valid("query");

  const conditions = [eq(schema.orders.providerId, id)];
  if (from && to) {
    conditions.push(
      between(schema.orders.scheduledAt, new Date(from), new Date(to)),
    );
  } else if (from) {
    conditions.push(gte(schema.orders.scheduledAt, new Date(from)));
  } else if (to) {
    conditions.push(lte(schema.orders.scheduledAt, new Date(to)));
  }

  const rows = await db
    .select({
      order: schema.orders,
      customerName: schema.customers.name,
      customerEmail: schema.customers.email,
      customerPhone: schema.customers.phone,
    })
    .from(schema.orders)
    .leftJoin(
      schema.customers,
      eq(schema.orders.customerId, schema.customers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(schema.orders.scheduledAt))
    .limit(200);

  return c.json<OrderWithCustomer[]>(
    rows.map((r) => ({
      ...r.order,
      customer: {
        name: r.customerName,
        email: r.customerEmail,
        phone: r.customerPhone,
      },
    })),
  );
});

// POST /orders/:orderId/assign — assign / reassign the mechanic on an order.
// Routes through the order-state harness so the write is audited
// (order_events row) and passes the same validation as other lifecycle ops.
adminMechanics.post(
  "/orders/:orderId/assign",
  zValidator("json", assignProviderInput),
  async (c) => {
    const orderId = Number(c.req.param("orderId"));
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return c.json<ApiError>(
        { error: { code: "BAD_REQUEST", message: "Invalid order ID" } },
        400,
      );
    }

    const body = c.req.valid("json");

    // Pre-check the provider here so the "mechanic not found" error keeps its
    // specific wording — the harness's `not_found` path is keyed on the id we
    // pass in, so routing this through `sendOrderStateResult` alone would
    // surface it as "Order #<providerId> not found" in the admin dialog.
    const [provider] = await db
      .select({ id: schema.providers.id })
      .from(schema.providers)
      .where(eq(schema.providers.id, body.providerId))
      .limit(1);
    if (!provider) {
      return c.json<ApiError>(
        { error: { code: "NOT_FOUND", message: "Target mechanic not found" } },
        404,
      );
    }

    const authUser = c.get("authUser");
    const result = await assignProvider(
      orderId,
      body.providerId,
      adminActor(authUser.email),
      { force: body.force },
    );
    return sendOrderStateResult(c, result);
  },
);

export { adminMechanics };
