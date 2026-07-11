import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, between, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "@hmls/agent/db";
import { type MechanicEnv, requireMechanic } from "../middleware/mechanic.ts";
import { requireShopContext, type WithShop } from "../middleware/shop-context.ts";
import { withTenantTx } from "../middleware/with-tenant-tx.ts";
import { recordPayment, transition } from "@hmls/agent/order-state";
import { canonicalizeStatus } from "@hmls/shared/order/status";
import { recordOutcome } from "@hmls/agent/fixo-brain";
import { sendOrderStateResult } from "../lib/order-state-http.ts";
import {
  createMechanicOverrideInput,
  listMechanicOverridesQuery,
  listMyOrdersQuery,
  mechanicTransitionInput,
  setMechanicAvailabilityInput,
} from "@hmls/shared/api/contracts/mechanic";
import { recordPaymentInput } from "@hmls/shared/api/contracts/orders";
import type {
  OrderRowWithIntake,
  ProviderAvailabilityRow,
  ProviderRow,
  ProviderScheduleOverrideRow,
} from "@hmls/shared/db/types";

type ApiError = { error: { code: string; message: string } };

const mechanic = new Hono<WithShop<MechanicEnv>>();

mechanic.use("*", requireMechanic);
mechanic.use("*", requireShopContext);
mechanic.use("*", withTenantTx("shop"));

// ---------------------------------------------------------------------------
// GET /me — current mechanic's provider record
// ---------------------------------------------------------------------------

mechanic.get("/me", async (c) => {
  const providerId = c.get("providerId");
  const [provider] = await db
    .select()
    .from(schema.providers) // tenant-ok: providerId comes from authenticated session; mechanic reads only their own row
    .where(eq(schema.providers.id, providerId)) // tenant-ok: scoped to authenticated mechanic's own record
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
  const shopId = c.get("shopId");
  const { from, to } = c.req.valid("query");

  const conditions = [eq(schema.orders.providerId, providerId), eq(schema.orders.shopId, shopId)];
  // Unscheduled-but-assigned orders (scheduledAt IS NULL) are the "Pending
  // schedule" bucket the mechanic page renders via partitionBySchedule. A bare
  // `scheduledAt >= from` is NULL (not TRUE) for those rows and would drop them
  // entirely, making that bucket unreachable — so always OR-in the null case.
  if (from && to) {
    conditions.push(
      or(
        isNull(schema.orders.scheduledAt),
        between(schema.orders.scheduledAt, new Date(from), new Date(to)),
      )!,
    );
  } else if (from) {
    conditions.push(
      or(isNull(schema.orders.scheduledAt), gte(schema.orders.scheduledAt, new Date(from)))!,
    );
  } else if (to) {
    conditions.push(
      or(isNull(schema.orders.scheduledAt), lte(schema.orders.scheduledAt, new Date(to)))!,
    );
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

// ---------------------------------------------------------------------------
// POST /orders/:id/transition — mechanic drives their own job:
// approved → in_progress ("Start") and in_progress → completed ("Complete").
// ACTOR_PERMISSIONS in the harness is the rule table; this route only asserts
// ownership and translates the result to HTTP.
// ---------------------------------------------------------------------------

mechanic.post(
  "/orders/:id/transition",
  zValidator("json", mechanicTransitionInput),
  async (c) => {
    const providerId = c.get("providerId");
    const shopId = c.get("shopId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
    }
    const body = c.req.valid("json");

    // Ownership double-scope: the order must be assigned to THIS mechanic AND
    // belong to their shop. Any mismatch is a 404, not 403 — don't leak that
    // the order exists.
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.id, id),
          eq(schema.orders.providerId, providerId),
          eq(schema.orders.shopId, shopId),
        ),
      )
      .limit(1);
    if (!order) {
      return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
    }

    // Transition FIRST, then persist the confirmed diagnosis + close the fixo
    // loop only on success. A rejected/duplicate Complete (stale card, order
    // no longer in_progress, concurrent cancel) must not stamp a diagnosis
    // onto a wrong-state order or report a calibration outcome for a
    // completion that never happened.
    const result = await transition(id, body.to, { kind: "mechanic", providerId });

    const diag = body.confirmedDiagnosis?.trim();
    if (result.ok && body.to === "completed" && diag) {
      // Same direct column write the admin complete flow does via PATCH /orders/:id.
      await db
        .update(schema.orders)
        .set({ confirmedDiagnosis: diag, updatedAt: new Date() })
        .where(
          and(
            eq(schema.orders.id, id),
            eq(schema.orders.providerId, providerId),
            eq(schema.orders.shopId, shopId),
          ),
        );

      // Loop closer (mirrors admin PATCH /orders/:id): report the confirmed
      // outcome back to the brain for fixo-linked orders. Fire-and-forget — a
      // calibration write must never block or fail the completion.
      if (order.fixoPredictionId) {
        recordOutcome({
          predictionId: order.fixoPredictionId,
          confirmedDiagnosis: diag,
          actualCostCents: order.paidAmountCents ?? order.subtotalCents,
        }).catch((err) => {
          console.error(`recordOutcome failed for order ${id}:`, String(err));
        });
      }
    }

    return sendOrderStateResult(c, result);
  },
);

// ---------------------------------------------------------------------------
// POST /orders/:id/payment — on-the-spot collection after Complete. Same body
// as the admin route (shared recordPaymentInput contract); same ownership
// double-scope as the transition route. Mechanics can only stamp payment on
// their own COMPLETED job — deposits on approved orders stay admin-only.
// recordPayment overwrites the payment fields on repeat submission (retry
// semantics, no stacking) and writes collectedBy into the event metadata.
// ---------------------------------------------------------------------------

mechanic.post(
  "/orders/:id/payment",
  zValidator("json", recordPaymentInput),
  async (c) => {
    const providerId = c.get("providerId");
    const shopId = c.get("shopId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
    }
    const body = c.req.valid("json");

    // Ownership double-scope: mismatch is a 404, not 403 — don't leak that
    // the order exists.
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.id, id),
          eq(schema.orders.providerId, providerId),
          eq(schema.orders.shopId, shopId),
        ),
      )
      .limit(1);
    if (!order) {
      return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
    }

    if (canonicalizeStatus(order.status) !== "completed") {
      return c.json<ApiError>(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Payment can only be recorded on a completed job",
          },
        },
        400,
      );
    }

    const result = await recordPayment(id, {
      amountCents: body.amountCents,
      method: body.method,
      reference: body.reference ?? null,
      paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
    }, { kind: "mechanic", providerId });
    return sendOrderStateResult(c, result);
  },
);

export { mechanic };
