// Auto-dispatch: pick a mechanic for a freshly scheduled order.
//
// Heuristic (Uber-style):
//   1. Eligible = active mechanics with no conflicting blocked_range
//   2. Prefer the customer's prior mechanic (any `completed` order)
//   3. Fall back to the eligible mechanic with the fewest scheduled jobs
//      in the next 7 days
//
// Triggered automatically after `attachSchedule` succeeds on an unassigned
// order. Admin can still reassign via the order detail action panel.

import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { db, schema } from "../db/client.ts";
import type { Actor } from "@hmls/shared/order/status";
import { assignProvider } from "./order-state.ts";

const logger = getLogger(["hmls", "agent", "auto-assign"]);

const LOAD_LOOKAHEAD_DAYS = 7;

const SYSTEM_DISPATCH_ACTOR: Actor = {
  kind: "system",
  source: "auto_dispatch",
};

export interface AutoAssignOutcome {
  /** ID of the picked mechanic, or null if no mechanic was eligible. */
  providerId: number | null;
  /** Short reason when no mechanic could be picked or assignment failed. */
  reason?: string;
}

/** Find and assign the best available mechanic for an already-scheduled
 *  order. No-op if the order is already assigned or has no scheduling
 *  data. Returns the picked providerId on success, or null with a reason. */
export async function autoAssignProvider(
  orderId: number,
): Promise<AutoAssignOutcome> {
  const [order] = await db
    .select({
      id: schema.orders.id,
      shopId: schema.orders.shopId,
      customerId: schema.orders.customerId,
      providerId: schema.orders.providerId,
      scheduledAt: schema.orders.scheduledAt,
      durationMinutes: schema.orders.durationMinutes,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return { providerId: null, reason: "order not found" };
  }
  if (order.providerId != null) {
    return { providerId: order.providerId, reason: "already assigned" };
  }
  if (!order.scheduledAt || !order.durationMinutes) {
    return { providerId: null, reason: "order is not scheduled" };
  }

  const slotStart = order.scheduledAt;
  const slotEnd = new Date(
    slotStart.getTime() + order.durationMinutes * 60_000,
  );

  // 1. Active mechanics with NO conflicting order blocking the slot.
  // We compare against `blocked_range` which the trigger keeps in sync
  // with scheduled_at + duration_minutes.
  const conflictExists = sql<boolean>`EXISTS (
    SELECT 1 FROM ${schema.orders} o2
    WHERE o2.provider_id = ${schema.providers.id}
      AND o2.id <> ${orderId}
      AND o2.status NOT IN ('cancelled', 'declined')
      AND o2.blocked_range && tstzrange(${slotStart.toISOString()}, ${slotEnd.toISOString()}, '[)')
  )`;

  const eligible = await db
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(
      and(
        eq(schema.providers.shopId, order.shopId),
        eq(schema.providers.isActive, true),
        sql`NOT ${conflictExists}`,
      ),
    );

  if (eligible.length === 0) {
    logger.info("auto-assign: no eligible mechanics for order #{orderId}", {
      orderId,
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
    });
    return { providerId: null, reason: "no available mechanic for this slot" };
  }

  const eligibleIds = eligible.map((e) => e.id);

  // 2. Customer-history preference: most recent completed order with one
  // of the eligible mechanics, if any.
  let pickedId: number | null = null;
  if (order.customerId != null) {
    const [historical] = await db
      .select({ providerId: schema.orders.providerId })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.customerId, order.customerId),
          eq(schema.orders.status, "completed"),
          inArray(schema.orders.providerId, eligibleIds),
          ne(schema.orders.id, orderId),
        ),
      )
      .orderBy(desc(schema.orders.scheduledAt))
      .limit(1);
    if (historical?.providerId != null) {
      pickedId = historical.providerId;
    }
  }

  // 3. Round-robin fallback: pick the eligible mechanic with the fewest
  // upcoming scheduled jobs in the lookahead window.
  if (pickedId == null) {
    const now = new Date();
    const horizon = new Date(
      now.getTime() + LOAD_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
    );
    const loads = await db
      .select({
        providerId: schema.orders.providerId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          inArray(schema.orders.providerId, eligibleIds),
          gte(schema.orders.scheduledAt, now),
          lte(schema.orders.scheduledAt, horizon),
          sql`${schema.orders.status} NOT IN ('cancelled', 'declined')`,
        ),
      )
      .groupBy(schema.orders.providerId);

    const loadMap = new Map<number, number>();
    for (const row of loads) {
      if (row.providerId != null) loadMap.set(row.providerId, Number(row.cnt));
    }
    pickedId = [...eligibleIds].sort(
      (a, b) => (loadMap.get(a) ?? 0) - (loadMap.get(b) ?? 0),
    )[0];
  }

  const result = await assignProvider(orderId, pickedId, SYSTEM_DISPATCH_ACTOR);
  if (!result.ok) {
    logger.warn(
      "auto-assign: assignProvider failed for order #{orderId} -> mechanic #{providerId}",
      { orderId, providerId: pickedId, error: result.error },
    );
    return {
      providerId: null,
      reason: `assignment failed: ${
        "reason" in result.error ? result.error.reason : result.error.code
      }`,
    };
  }

  logger.info(
    "auto-assign: assigned mechanic #{providerId} to order #{orderId}",
    { orderId, providerId: pickedId },
  );
  return { providerId: pickedId };
}
