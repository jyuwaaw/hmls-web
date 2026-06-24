// L2 — hits real Postgres. DESTRUCTIVE: opt-in only.
//
// Exercises the `cancel_abandoned_drafts` SQL function (migration 0034) that the
// gateway's Deno.cron drives daily. The function is table-wide, so to make a
// fresh fixture eligible (the compute_blocked_range trigger force-sets
// updated_at = now() on every write, blocking backdating) we call it with a
// negative threshold — which matches EVERY unscheduled draft in the database,
// not just our fixture. We run inside ONE transaction that is rolled back, so
// nothing is committed, but the UPDATE still takes row locks on those drafts for
// the duration. That's unsafe against a shared/prod DB, so this test is gated
// behind ALLOW_DESTRUCTIVE_DB_TEST=1 and should target an isolated DB.
//
//   ALLOW_DESTRUCTIVE_DB_TEST=1 DATABASE_URL=... deno test src/services/cancel-abandoned-drafts_db_test.ts
import { assertEquals } from "@std/assert";
import { db, schema } from "../db/client.ts";
import { eq, sql } from "drizzle-orm";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const ALLOW_DESTRUCTIVE = Deno.env.get("ALLOW_DESTRUCTIVE_DB_TEST") === "1";
const MARK = "[cancel-drafts-l2]";

class Rollback extends Error {}

Deno.test({
  name: "cancel_abandoned_drafts cancels eligible drafts only, with audit trail",
  ignore: !DATABASE_URL || !ALLOW_DESTRUCTIVE,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      await db.transaction(async (tx) => {
        const [shop] = await tx.insert(schema.shops).values({
          name: `${MARK} shop`,
          slug: `${MARK}-${crypto.randomUUID()}`,
        }).returning();
        const [cust] = await tx.insert(schema.customers).values({
          name: `${MARK} cust`,
          shopId: shop.id,
        }).returning();

        const base = { shopId: shop.id, customerId: cust.id };
        // D1: abandoned draft (no scheduled_at) -> should be cancelled.
        const [d1] = await tx.insert(schema.orders).values({
          ...base,
          status: "draft",
          statusHistory: [],
          shareToken: `${MARK}-d1-${crypto.randomUUID()}`,
        }).returning();
        // D2: draft with a tentative scheduled_at -> must be left alone.
        const [d2] = await tx.insert(schema.orders).values({
          ...base,
          status: "draft",
          scheduledAt: new Date(Date.now() + 7 * 86_400_000),
          durationMinutes: 60,
          shareToken: `${MARK}-d2-${crypto.randomUUID()}`,
        }).returning();
        // D3: non-draft -> must be left alone.
        const [d3] = await tx.insert(schema.orders).values({
          ...base,
          status: "estimated",
          shareToken: `${MARK}-d3-${crypto.randomUUID()}`,
        }).returning();

        await tx.execute(sql`SELECT cancel_abandoned_drafts(-1)`);

        const rows = await tx.select({ id: schema.orders.id, status: schema.orders.status })
          .from(schema.orders)
          .where(eq(schema.orders.shopId, shop.id));
        const statusById = new Map(rows.map((r) => [r.id, r.status]));
        assertEquals(statusById.get(d1.id), "cancelled"); // eligible draft reaped
        assertEquals(statusById.get(d2.id), "draft"); // scheduled draft untouched
        assertEquals(statusById.get(d3.id), "estimated"); // non-draft untouched

        // Audit: one status_change order_events row for D1.
        const events = await tx.select()
          .from(schema.orderEvents)
          .where(eq(schema.orderEvents.orderId, d1.id));
        assertEquals(
          events.some((e) =>
            e.toStatus === "cancelled" && e.fromStatus === "draft" &&
            e.actor === "system:abandoned-cleanup"
          ),
          true,
        );

        // Audit: status_history got the cancelled entry appended.
        const [d1after] = await tx.select({ history: schema.orders.statusHistory })
          .from(schema.orders)
          .where(eq(schema.orders.id, d1.id));
        const history = d1after.history as Array<{ status: string; actor: string }>;
        assertEquals(history.at(-1)?.status, "cancelled");
        assertEquals(history.at(-1)?.actor, "system:abandoned-cleanup");

        throw new Rollback(); // undo everything, including any real drafts swept by -1
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  },
});
