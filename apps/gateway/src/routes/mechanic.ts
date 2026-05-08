import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, between, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@hmls/agent/db";
import { type MechanicEnv, requireMechanic } from "../middleware/mechanic.ts";
import {
  createMechanicOverrideInput,
  listMechanicOverridesQuery,
  listMyOrdersQuery,
  setMechanicAvailabilityInput,
} from "@hmls/shared/api/contracts/mechanic";
import type {
  OrderRowWithIntake,
  ProviderAvailabilityRow,
  ProviderRow,
  ProviderScheduleOverrideRow,
} from "@hmls/shared/db/types";

type ApiError = { error: { code: string; message: string } };

const mechanic = new Hono<MechanicEnv>();

mechanic.use("*", requireMechanic);

// ---------------------------------------------------------------------------
// GET /me — current mechanic's provider record
// ---------------------------------------------------------------------------

mechanic.get("/me", async (c) => {
  const providerId = c.get("providerId");
  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, providerId))
    .limit(1);

  if (!provider) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Provider not found" } }, 404);
  }
  return c.json<ProviderRow>(provider);
});

// ---------------------------------------------------------------------------
// Weekly availability
// ---------------------------------------------------------------------------

mechanic.get("/availability", async (c) => {
  const providerId = c.get("providerId");
  const rows = await db
    .select()
    .from(schema.providerAvailability)
    .where(eq(schema.providerAvailability.providerId, providerId))
    .orderBy(asc(schema.providerAvailability.dayOfWeek));
  return c.json<ProviderAvailabilityRow[]>(rows);
});

// Replace the full weekly schedule atomically
mechanic.put("/availability", zValidator("json", setMechanicAvailabilityInput), async (c) => {
  const providerId = c.get("providerId");
  const body = c.req.valid("json");

  // Business rule beyond shape: endTime must be after startTime
  for (const row of body.availability) {
    if (row.endTime <= row.startTime) {
      return c.json<ApiError>(
        { error: { code: "BAD_REQUEST", message: "endTime must be after startTime" } },
        400,
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.providerAvailability)
      .where(eq(schema.providerAvailability.providerId, providerId));
    if (body.availability.length > 0) {
      await tx.insert(schema.providerAvailability).values(
        body.availability.map((a) => ({ providerId, ...a })),
      );
    }
  });

  const rows = await db
    .select()
    .from(schema.providerAvailability)
    .where(eq(schema.providerAvailability.providerId, providerId))
    .orderBy(asc(schema.providerAvailability.dayOfWeek));
  return c.json<ProviderAvailabilityRow[]>(rows);
});

// ---------------------------------------------------------------------------
// Date-specific overrides (time off, extra hours)
// ---------------------------------------------------------------------------

mechanic.get("/overrides", zValidator("query", listMechanicOverridesQuery), async (c) => {
  const providerId = c.get("providerId");
  const { from, to } = c.req.valid("query");

  const conditions = [eq(schema.providerScheduleOverrides.providerId, providerId)];
  if (from) conditions.push(gte(schema.providerScheduleOverrides.overrideDate, from));
  if (to) conditions.push(lte(schema.providerScheduleOverrides.overrideDate, to));

  const rows = await db
    .select()
    .from(schema.providerScheduleOverrides)
    .where(and(...conditions))
    .orderBy(asc(schema.providerScheduleOverrides.overrideDate));
  return c.json<ProviderScheduleOverrideRow[]>(rows);
});

mechanic.post("/overrides", zValidator("json", createMechanicOverrideInput), async (c) => {
  const providerId = c.get("providerId");
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

  // Upsert: one override per (provider, date). Delete any existing first.
  await db
    .delete(schema.providerScheduleOverrides)
    .where(
      and(
        eq(schema.providerScheduleOverrides.providerId, providerId),
        eq(schema.providerScheduleOverrides.overrideDate, body.overrideDate),
      ),
    );

  const [created] = await db
    .insert(schema.providerScheduleOverrides)
    .values({
      providerId,
      overrideDate: body.overrideDate,
      isAvailable: body.isAvailable,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      reason: body.reason ?? null,
    })
    .returning();
  return c.json<ProviderScheduleOverrideRow>(created, 201);
});

mechanic.delete("/overrides/:id", async (c) => {
  const providerId = c.get("providerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid override ID" } },
      400,
    );
  }

  const result = await db
    .delete(schema.providerScheduleOverrides)
    .where(
      and(
        eq(schema.providerScheduleOverrides.id, id),
        eq(schema.providerScheduleOverrides.providerId, providerId),
      ),
    )
    .returning({ id: schema.providerScheduleOverrides.id });

  if (result.length === 0) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Override not found" } }, 404);
  }
  return c.json<{ ok: true }>({ ok: true });
});

// ---------------------------------------------------------------------------
// My orders (mechanic's assigned work)
// ---------------------------------------------------------------------------

mechanic.get("/orders", zValidator("query", listMyOrdersQuery), async (c) => {
  const providerId = c.get("providerId");
  const { from, to } = c.req.valid("query");

  const conditions = [eq(schema.orders.providerId, providerId)];
  if (from && to) {
    conditions.push(between(schema.orders.scheduledAt, new Date(from), new Date(to)));
  } else if (from) {
    conditions.push(gte(schema.orders.scheduledAt, new Date(from)));
  } else if (to) {
    conditions.push(lte(schema.orders.scheduledAt, new Date(to)));
  }

  const rows = await db
    .select({ order: schema.orders, intake: schema.orderIntake })
    .from(schema.orders)
    .leftJoin(
      schema.orderIntake,
      eq(schema.orderIntake.orderId, schema.orders.id),
    )
    .where(and(...conditions))
    .orderBy(asc(schema.orders.scheduledAt));
  const withIntake: OrderRowWithIntake[] = rows.map((r) => ({ ...r.order, intake: r.intake }));
  return c.json<OrderRowWithIntake[]>(withIntake);
});

export { mechanic };
