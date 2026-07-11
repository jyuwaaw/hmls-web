// L2 DB tests for the order-state harness (7-state machine). Exercises
// invariants that the pure L1 suite cannot: transactional atomicity,
// optimistic concurrency, multi-event writes, trigger interactions, actor
// string stamping, the legacy-label deploy→remap window cases, and the
// schedule_ready notification dedup (C6).
//
// These tests hit the real Postgres behind DATABASE_URL. They skip cleanly
// if no URL is set (fast pure-L1 workflow remains available). Every step
// creates + deletes its own order row; the ON DELETE CASCADE on
// order_events takes care of audit rows.
//
// All steps run inside one top-level Deno.test so the shared postgres
// connection pool only needs one sanitizeOps exemption, and a single
// test customer fixture is reused.
//
// Run locally against the LOCAL Supabase (never prod):
//   supabase start
//   scripts/db-local-reset.sh   # or apply migrations 0043+0044 by hand
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     deno test -A apps/agent/src/services/order-state_db_test.ts

import { assertEquals, assertStrictEquals } from "@std/assert";
import { desc, eq, like } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import {
  addNote,
  assignProvider,
  attachSchedule,
  patchItems,
  recordPayment,
  transition,
} from "./order-state.ts";
import { notifyMechanic } from "../lib/notifications.ts";
import { autoAssignProvider } from "./auto-assign.ts";
import type { Actor, OrderStatus, PhysicalOrderStatus } from "@hmls/shared/order/status";
import type { OrderItem } from "@hmls/shared/db/schema";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

// Marker for test-owned fixtures. Any customer/order with this prefix in
// name/contactName can be swept safely.
const TEST_MARKER = "[order-state-l2-test]";
const TEST_CUSTOMER_EMAIL = "order-state-l2-test@hmls.local";
const TEST_SHOP_SLUG = "order-state-l2-test";

async function ensureTestShop(): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.shops)
    .where(eq(schema.shops.slug, TEST_SHOP_SLUG))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.shops)
    .values({
      name: `${TEST_MARKER} shop`,
      slug: TEST_SHOP_SLUG,
    })
    .returning({ id: schema.shops.id });
  return created.id;
}

async function ensureTestCustomer(shopId: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.email, TEST_CUSTOMER_EMAIL))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.customers)
    .values({
      shopId,
      name: `${TEST_MARKER} customer`,
      email: TEST_CUSTOMER_EMAIL,
    })
    .returning();
  return created.id;
}

async function sweepStaleFixtures(): Promise<void> {
  // Deletes orders first (cascades to order_events), then test mechanics
  // (cascades to availability/overrides). The test customer is left in
  // place for the next run.
  await db.delete(schema.orders).where(like(schema.orders.contactName, `${TEST_MARKER}%`));
  await db.delete(schema.providers).where(like(schema.providers.name, `${TEST_MARKER}%`));
}

async function insertTestMechanic(
  shopId: string,
  opts: { name?: string; isActive?: boolean; email?: string | null } = {},
): Promise<typeof schema.providers.$inferSelect> {
  const [row] = await db
    .insert(schema.providers)
    .values({
      shopId,
      name: `${TEST_MARKER} ${opts.name ?? crypto.randomUUID().slice(0, 8)}`,
      isActive: opts.isActive ?? true,
      email: opts.email ?? null,
    })
    .returning();
  return row;
}

async function deleteMechanic(id: number): Promise<void> {
  await db.delete(schema.providers).where(eq(schema.providers.id, id));
}

async function insertTestOrder(opts: {
  shopId: string;
  /** Physical status — legacy 'scheduled'/'revised' allowed to simulate
   *  pre-remap window rows. */
  status: PhysicalOrderStatus;
  customerId: number;
  items?: OrderItem[];
  revisionNumber?: number;
  providerId?: number | null;
  scheduledAt?: Date | null;
  durationMinutes?: number | null;
  statusHistory?: Array<{ status: string; timestamp: string; actor: string }>;
}): Promise<typeof schema.orders.$inferSelect> {
  const items = opts.items ?? [];
  const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
  const [row] = await db
    .insert(schema.orders)
    .values({
      shopId: opts.shopId,
      customerId: opts.customerId,
      status: opts.status,
      statusHistory: opts.statusHistory ?? [{
        status: opts.status,
        timestamp: new Date().toISOString(),
        actor: "test_setup",
      }],
      items,
      subtotalCents,
      revisionNumber: opts.revisionNumber ?? 1,
      providerId: opts.providerId ?? null,
      scheduledAt: opts.scheduledAt ?? null,
      durationMinutes: opts.durationMinutes ?? (opts.scheduledAt ? 60 : null),
      shareToken: crypto.randomUUID().replace(/-/g, ""),
      contactName: `${TEST_MARKER} ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row;
}

async function deleteOrder(orderId: number): Promise<void> {
  await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
}

async function getEvents(orderId: number) {
  return await db
    .select()
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.orderId, orderId))
    .orderBy(desc(schema.orderEvents.createdAt));
}

async function reloadOrder(orderId: number) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  return row;
}

function sampleItem(name: string, totalCents: number): OrderItem {
  return {
    id: crypto.randomUUID(),
    category: "labor",
    name,
    quantity: 1,
    unitPriceCents: totalCents,
    totalCents,
    taxable: true,
  };
}

function futureDate(hoursFromNow: number): Date {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
}

const ADMIN_ACTOR: Actor = { kind: "admin", email: "l2test@shop.com" };

Deno.test({
  name: "order-state L2 DB suite",
  // The drizzle postgres pool keeps TCP connections open between steps.
  // Exempt this top-level test from Deno's strict op/resource sanitizers.
  sanitizeOps: false,
  sanitizeResources: false,
  ignore: !DATABASE_URL,
  async fn(t) {
    await sweepStaleFixtures();
    const shopId = await ensureTestShop();
    const customerId = await ensureTestCustomer(shopId);

    await t.step("transition: admin draft -> estimated emits status_change", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const result = await transition(order.id, "estimated", ADMIN_ACTOR, {
          suppressNotification: true,
        });
        assertEquals(result.ok, true, `transition should succeed`);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "estimated");

        const history = updated.statusHistory as Array<{ status: string; actor: string }>;
        assertEquals(history.length, 2, "statusHistory should have initial + new entry");
        assertEquals(history[1].status, "estimated");
        assertEquals(history[1].actor, "admin:l2test@shop.com");

        const events = await getEvents(order.id);
        const statusChangeEvents = events.filter((e) => e.eventType === "status_change");
        assertEquals(statusChangeEvents.length, 1);
        assertEquals(statusChangeEvents[0].fromStatus, "draft");
        assertEquals(statusChangeEvents[0].toStatus, "estimated");
        assertEquals(statusChangeEvents[0].actor, "admin:l2test@shop.com");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("transition: forbidden actor does NOT mutate or emit event", async () => {
      const mech = await insertTestMechanic(shopId, { name: "forbidden-start" });
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        providerId: mech.id,
      });
      try {
        // Customer cannot start work — mechanic/admin only.
        const customerActor: Actor = { kind: "customer", customerId };
        const result = await transition(order.id, "in_progress", customerActor, {
          suppressNotification: true,
        });
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "forbidden");

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "approved", "status must not have changed");

        const events = await getEvents(order.id);
        assertEquals(events.length, 0, "no events on forbidden transition");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("transition: optimistic lock — second writer blocked", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        // Fire two transitions concurrently. Depending on which SELECT
        // interleaves with which UPDATE, the loser gets:
        //   - `conflict`          (both read stale, one UPDATE loses the guard)
        //   - `invalid_transition` (loser's SELECT saw winner's committed row)
        // Both are correct; the invariant that matters is "exactly one
        // committed audit event".
        const [a, b] = await Promise.all([
          transition(order.id, "estimated", ADMIN_ACTOR, { suppressNotification: true }),
          transition(order.id, "estimated", ADMIN_ACTOR, { suppressNotification: true }),
        ]);

        const winners = [a, b].filter((r) => r.ok).length;
        const losers = [a, b].filter((r) => !r.ok).length;
        assertEquals(winners, 1, "exactly one transition should succeed");
        assertEquals(losers, 1, "exactly one transition should be rejected");

        const loser = ([a, b].find((r) => !r.ok))!;
        if (!loser.ok) {
          const code = loser.error.code;
          assertEquals(
            code === "conflict" || code === "invalid_transition",
            true,
            `expected conflict or invalid_transition, got ${code}`,
          );
        }

        // Strong invariant: only ONE status_change event committed. If the
        // loser's transaction had leaked its event insert, we would see two.
        const events = await getEvents(order.id);
        const statusChangeEvents = events.filter((e) => e.eventType === "status_change");
        assertEquals(
          statusChangeEvents.length,
          1,
          "exactly one audit event committed (transaction isolation verified)",
        );
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("transition: cancelled with reason persists cancellationReason", async () => {
      const order = await insertTestOrder({ shopId, status: "estimated", customerId });
      try {
        const result = await transition(order.id, "cancelled", ADMIN_ACTOR, {
          reason: "Customer out of town",
          suppressNotification: true,
        });
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.cancellationReason, "Customer out of town");

        const events = await getEvents(order.id);
        const statusChange = events.find((e) => e.eventType === "status_change");
        const meta = statusChange?.metadata as { reason?: string } | null;
        assertEquals(meta?.reason, "Customer out of town");
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // 【REGRESSION-CRITICAL】Deploy→remap window: physical rows still carry
    // legacy labels. Rules must run on the canonical value, the optimistic
    // lock must hit the RAW value, and the write must converge the row.
    // -------------------------------------------------------------------

    await t.step(
      "window: physical 'scheduled' row starts work as approved + converges",
      async () => {
        const mech = await insertTestMechanic(shopId, { name: "window-start" });
        const order = await insertTestOrder({
          shopId,
          status: "scheduled", // legacy physical label
          customerId,
          providerId: mech.id,
          scheduledAt: futureDate(24),
        });
        try {
          const mechActor: Actor = { kind: "mechanic", providerId: mech.id };
          const result = await transition(order.id, "in_progress", mechActor, {
            suppressNotification: true,
          });
          assertEquals(result.ok, true, "validated as canonical approved -> in_progress");

          const after = await reloadOrder(order.id);
          assertEquals(after.status, "in_progress", "row converged to canonical status");

          const events = await getEvents(order.id);
          const statusChange = events.find((e) => e.eventType === "status_change");
          assertEquals(statusChange?.fromStatus, "approved", "event records canonical from");
          assertEquals(statusChange?.toStatus, "in_progress");
        } finally {
          await deleteOrder(order.id);
          await deleteMechanic(mech.id);
        }
      },
    );

    await t.step("window: physical 'scheduled' row cancels (guard hits raw value)", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "scheduled", // legacy physical label
        customerId,
        scheduledAt: futureDate(24),
      });
      try {
        const result = await transition(order.id, "cancelled", ADMIN_ACTOR, {
          reason: "window cancel",
          suppressNotification: true,
        });
        assertEquals(
          result.ok,
          true,
          "optimistic lock must match the RAW 'scheduled' value, not canonical",
        );
        const after = await reloadOrder(order.id);
        assertEquals(after.status, "cancelled");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("window: legacy target 'scheduled' input canonicalizes to approved", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        // Old callers may still send the retired label during the deploy
        // window; transition() maps it through canonicalizeStatus.
        const result = await transition(
          order.id,
          "scheduled" as unknown as OrderStatus,
          ADMIN_ACTOR,
          { suppressNotification: true, authorization: { channel: "in_person" } },
        );
        assertEquals(result.ok, true);
        const after = await reloadOrder(order.id);
        assertEquals(after.status, "approved", "legacy target written as canonical");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("window: physical 'revised' row is editable as canonical draft", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "revised", // legacy physical label
        customerId,
        items: [sampleItem("Original", 10000)],
      });
      try {
        const result = await patchItems(
          order.id,
          { items: [sampleItem("Edited", 12000)] },
          ADMIN_ACTOR,
        );
        assertEquals(result.ok, true, "canonical draft is editable; raw guard must match");

        const updated = await reloadOrder(order.id);
        assertEquals(updated.revisionNumber, 2, "revisionNumber bumped");
        assertEquals(updated.subtotalCents, 12000);
        // patchItems only writes status on the estimated->draft pullback;
        // a legacy 'revised' row converges lazily on its next status write.
        assertEquals(updated.status, "revised");
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // 【REGRESSION】patchItems pullback: estimated -> draft
    // -------------------------------------------------------------------

    await t.step("patchItems: estimated pulls back to draft, emits 2 events", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        items: [sampleItem("Original service", 10000)],
        statusHistory: [
          { status: "draft", timestamp: new Date().toISOString(), actor: "test_setup" },
          { status: "estimated", timestamp: new Date().toISOString(), actor: "test_setup" },
        ],
      });
      try {
        const newItems = [sampleItem("Revised service", 15000)];
        const result = await patchItems(order.id, { items: newItems }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "draft", "status should pull back to draft");
        assertEquals(updated.subtotalCents, 15000, "subtotal recomputed from items");
        assertEquals(updated.revisionNumber, 2, "revisionNumber bumped");

        const history = updated.statusHistory as Array<{ status: string }>;
        assertEquals(history[history.length - 1].status, "draft", "statusHistory appended");
        // The estimated entry is retained — hasBeenSentToCustomer stays true.
        assertEquals(history.some((h) => h.status === "estimated"), true);

        const events = await getEvents(order.id);
        const itemsEdited = events.filter((e) => e.eventType === "items_edited");
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(itemsEdited.length, 1, "one items_edited event");
        assertEquals(statusChange.length, 1, "one status_change event for the pullback");
        assertEquals(statusChange[0].fromStatus, "estimated");
        assertEquals(statusChange[0].toStatus, "draft");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("patchItems: expectedVersion mismatch returns conflict", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "draft",
        customerId,
        revisionNumber: 5,
        items: [sampleItem("Item", 5000)],
      });
      try {
        const result = await patchItems(
          order.id,
          { items: [sampleItem("New", 7000)] },
          ADMIN_ACTOR,
          { expectedVersion: 3 }, // stale
        );
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "conflict");

        const after = await reloadOrder(order.id);
        assertEquals(after.revisionNumber, 5, "version unchanged on conflict");
        assertEquals(after.subtotalCents, 5000, "items unchanged on conflict");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("patchItems: autoRevertEstimatedToDraft=false stays in estimated", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        items: [sampleItem("Original", 10000)],
      });
      try {
        const result = await patchItems(
          order.id,
          { items: [sampleItem("Patched", 12000)] },
          ADMIN_ACTOR,
          { autoRevertEstimatedToDraft: false },
        );
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "estimated", "status preserved when autoRevert disabled");

        const events = await getEvents(order.id);
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(statusChange.length, 0, "no status_change event when pullback disabled");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("patchItems: approved order stays hard-blocked (PR 7 not in scope)", async () => {
      const order = await insertTestOrder({ shopId, status: "approved", customerId });
      try {
        const result = await patchItems(
          order.id,
          { items: [sampleItem("Mid-job add", 9000)] },
          ADMIN_ACTOR,
        );
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "not_editable");
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // Start guard (C1): approved -> in_progress requires providerId for
    // EVERY actor; scheduledAt is NOT required.
    // -------------------------------------------------------------------

    await t.step("start guard: no mechanic assigned -> rejected for any actor", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        scheduledAt: futureDate(24),
      });
      try {
        for (
          const actor of [
            ADMIN_ACTOR,
            { kind: "mechanic", providerId: 424242 } as Actor,
          ]
        ) {
          const result = await transition(order.id, "in_progress", actor, {
            suppressNotification: true,
          });
          assertStrictEquals(result.ok, false, `${actor.kind} must be blocked`);
          if (!result.ok) assertEquals(result.error.code, "invalid_input");
        }
        const after = await reloadOrder(order.id);
        assertEquals(after.status, "approved", "status unchanged");
        assertEquals((await getEvents(order.id)).length, 0, "no events emitted");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("start guard: mechanic assigned, NO scheduledAt -> allowed", async () => {
      const mech = await insertTestMechanic(shopId, { name: "adhoc-start" });
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        providerId: mech.id,
        scheduledAt: null, // ad-hoc on-site start is legal
      });
      try {
        const result = await transition(order.id, "in_progress", ADMIN_ACTOR, {
          suppressNotification: true,
        });
        assertEquals(result.ok, true, "scheduledAt must not be required to start");
        const after = await reloadOrder(order.id);
        assertEquals(after.status, "in_progress");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    // -------------------------------------------------------------------
    // attachSchedule: pure field update on every allowed status
    // -------------------------------------------------------------------

    await t.step("attachSchedule: approved order keeps status, populates fields", async () => {
      const order = await insertTestOrder({ shopId, status: "approved", customerId });
      try {
        const scheduledAt = futureDate(24);
        const result = await attachSchedule(order.id, {
          scheduledAt,
          durationMinutes: 90,
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "approved", "no status advance — scheduled state is gone");
        assertEquals(updated.durationMinutes, 90);
        assertEquals(
          updated.blockedRange != null,
          true,
          "compute_blocked_range trigger should populate blocked_range",
        );

        const events = await getEvents(order.id);
        assertEquals(events.filter((e) => e.eventType === "schedule_attached").length, 1);
        assertEquals(
          events.filter((e) => e.eventType === "status_change").length,
          0,
          "no status_change from scheduling",
        );
        // Slot set but no mechanic — pair incomplete, no schedule_ready yet.
        assertEquals(
          events.filter((e) => e.eventType === "schedule_ready_notified").length,
          0,
        );
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("attachSchedule: on estimated order is status-preserving", async () => {
      const order = await insertTestOrder({ shopId, status: "estimated", customerId });
      try {
        const result = await attachSchedule(order.id, {
          scheduledAt: futureDate(24),
          durationMinutes: 60,
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true, "estimated should accept schedule attach");

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "estimated", "status preserved on pre-approval booking");
        assertEquals(updated.scheduledAt != null, true);

        const events = await getEvents(order.id);
        assertEquals(events.filter((e) => e.eventType === "status_change").length, 0);
        assertEquals(events.filter((e) => e.eventType === "schedule_attached").length, 1);
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // schedule_ready dedup (C6): the "appointment confirmed" email fires
    // exactly once per order, on the write that completes the slot+mechanic
    // pair on an approved order. Reschedules take the change-mail path and
    // never re-claim the marker.
    // -------------------------------------------------------------------

    await t.step(
      "schedule_ready: pair completion via attachSchedule claims marker once",
      async () => {
        const mech = await insertTestMechanic(shopId, { name: "ready-attach" });
        const order = await insertTestOrder({ shopId, status: "approved", customerId });
        try {
          // Completes slot+mechanic in one write.
          const first = await attachSchedule(order.id, {
            scheduledAt: futureDate(24),
            durationMinutes: 60,
            providerId: mech.id,
          }, ADMIN_ACTOR);
          assertEquals(first.ok, true);

          let markers = (await getEvents(order.id)).filter(
            (e) => e.eventType === "schedule_ready_notified",
          );
          assertEquals(markers.length, 1, "pair completion claims the marker");

          // Reschedule (pair already complete, time changed): change-mail
          // path — must NOT insert a second marker.
          const second = await attachSchedule(order.id, {
            scheduledAt: futureDate(48),
            durationMinutes: 60,
          }, ADMIN_ACTOR);
          assertEquals(second.ok, true, "reschedule not blocked by the dedup marker");

          markers = (await getEvents(order.id)).filter(
            (e) => e.eventType === "schedule_ready_notified",
          );
          assertEquals(markers.length, 1, "still exactly one marker after reschedule");
        } finally {
          await deleteOrder(order.id);
          await deleteMechanic(mech.id);
        }
      },
    );

    await t.step("schedule_ready: assignProvider completing the pair claims marker", async () => {
      const mech = await insertTestMechanic(shopId, { name: "ready-assign" });
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        scheduledAt: futureDate(24),
        providerId: null,
      });
      try {
        const result = await assignProvider(order.id, mech.id, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const markers = (await getEvents(order.id)).filter(
          (e) => e.eventType === "schedule_ready_notified",
        );
        assertEquals(markers.length, 1, "assignProvider side claims the marker");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("schedule_ready: second completion path skips via unique marker", async () => {
      const mechA = await insertTestMechanic(shopId, { name: "ready-dedup-a" });
      const mechB = await insertTestMechanic(shopId, { name: "ready-dedup-b" });
      const order = await insertTestOrder({ shopId, status: "approved", customerId });
      try {
        // attachSchedule completes the pair -> claims marker.
        const attach = await attachSchedule(order.id, {
          scheduledAt: futureDate(24),
          durationMinutes: 60,
          providerId: mechA.id,
        }, ADMIN_ACTOR);
        assertEquals(attach.ok, true);

        // Reassign to another mechanic: pair was already complete, so no
        // second marker and no error (ON CONFLICT path never surfaces).
        const reassign = await assignProvider(order.id, mechB.id, ADMIN_ACTOR);
        assertEquals(reassign.ok, true);

        const markers = (await getEvents(order.id)).filter(
          (e) => e.eventType === "schedule_ready_notified",
        );
        assertEquals(markers.length, 1, "exactly one marker across both writers");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mechA.id);
        await deleteMechanic(mechB.id);
      }
    });

    await t.step("schedule_ready: approval on fully-scheduled order fires marker", async () => {
      const mech = await insertTestMechanic(shopId, { name: "ready-approve" });
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        providerId: mech.id,
        scheduledAt: futureDate(24),
        items: [sampleItem("Brake job", 20000)],
      });
      try {
        // Customer approves via portal — approved IS the booked state, so
        // the confirmation email point is reached right here.
        const result = await transition(
          order.id,
          "approved",
          { kind: "customer", customerId },
          { suppressNotification: true },
        );
        assertEquals(result.ok, true);

        const markers = (await getEvents(order.id)).filter(
          (e) => e.eventType === "schedule_ready_notified",
        );
        assertEquals(markers.length, 1, "approval with complete pair claims the marker");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("recordPayment: stamps payment fields on approved (booked) order", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        scheduledAt: futureDate(24),
      });
      try {
        const result = await recordPayment(order.id, {
          amountCents: 25000,
          method: "cash",
          reference: "receipt-123",
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.paymentMethod, "cash");
        assertEquals(updated.paymentReference, "receipt-123");
        assertEquals(updated.paidAmountCents, 25000);
        assertEquals(updated.paidAt != null, true);

        const events = await getEvents(order.id);
        const paymentEvents = events.filter((e) => e.eventType === "payment_recorded");
        assertEquals(paymentEvents.length, 1);
        const meta = paymentEvents[0].metadata as { collectedBy?: number };
        assertEquals(meta.collectedBy, undefined, "admin payments carry no collectedBy");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("recordPayment: mechanic actor allowed, event stamps collectedBy", async () => {
      const mech = await insertTestMechanic(shopId, { name: "collects-payment" });
      const order = await insertTestOrder({
        shopId,
        status: "completed",
        customerId,
        providerId: mech.id,
      });
      try {
        const result = await recordPayment(order.id, {
          amountCents: 18000,
          method: "zelle",
        }, { kind: "mechanic", providerId: mech.id });
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.paymentMethod, "zelle");
        assertEquals(updated.paidAmountCents, 18000);

        const events = await getEvents(order.id);
        const paymentEvents = events.filter((e) => e.eventType === "payment_recorded");
        assertEquals(paymentEvents.length, 1);
        assertEquals(paymentEvents[0].actor, `mechanic:${mech.id}`);
        const meta = paymentEvents[0].metadata as { collectedBy?: number };
        assertEquals(meta.collectedBy, mech.id, "audit names the collecting mechanic");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("recordPayment: customer actor forbidden", async () => {
      const order = await insertTestOrder({ shopId, status: "completed", customerId });
      try {
        const result = await recordPayment(order.id, {
          amountCents: 100,
          method: "cash",
        }, { kind: "customer", customerId });
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "forbidden");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("recordPayment: forbidden on cancelled order, no side effects", async () => {
      const order = await insertTestOrder({ shopId, status: "cancelled", customerId });
      try {
        const result = await recordPayment(order.id, {
          amountCents: 10000,
          method: "card",
        }, ADMIN_ACTOR);
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "forbidden");

        const after = await reloadOrder(order.id);
        assertEquals(after.paidAt, null);
        assertEquals(after.paymentMethod, null);
        assertEquals(after.paidAmountCents, null);

        const events = await getEvents(order.id);
        assertEquals(
          events.filter((e) => e.eventType === "payment_recorded").length,
          0,
        );
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("addNote: inserts note_added event with agent chain actor string", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const agentActor: Actor = {
          kind: "agent",
          surface: "staff_chat",
          actingAs: ADMIN_ACTOR,
        };
        const result = await addNote(order.id, "Customer called about ETA", agentActor);
        assertEquals(result.ok, true);

        const events = await getEvents(order.id);
        const notes = events.filter((e) => e.eventType === "note_added");
        assertEquals(notes.length, 1);
        assertEquals(notes[0].actor, "agent(staff_chat)->admin:l2test@shop.com");
        const meta = notes[0].metadata as { note?: string } | null;
        assertEquals(meta?.note, "Customer called about ETA");

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "draft", "addNote does not change status");
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // Compliance fence: any →approved transition requires customer-
    // authorization evidence from shop-side authorities and stamps it —
    // bound to revisionNumber + subtotalCents — into the status_change
    // event metadata.
    // -------------------------------------------------------------------

    await t.step("fence: admin estimated -> approved without evidence rejected", async () => {
      const order = await insertTestOrder({ shopId, status: "estimated", customerId });
      try {
        const result = await transition(order.id, "approved", ADMIN_ACTOR, {
          suppressNotification: true,
        });
        assertStrictEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "invalid_input");

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "estimated", "status must not change");
        const events = await getEvents(order.id);
        assertEquals(events.length, 0, "no event on rejected fenced transition");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("fence: admin approve with evidence stamps bound metadata", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        revisionNumber: 3,
        items: [sampleItem("Brake job", 12300)],
      });
      try {
        const result = await transition(order.id, "approved", ADMIN_ACTOR, {
          suppressNotification: true,
          authorization: { channel: "call", note: "spoke with owner" },
        });
        assertEquals(result.ok, true);

        const events = await getEvents(order.id);
        const statusChange = events.find((e) => e.eventType === "status_change");
        const meta = statusChange?.metadata as { authorization?: Record<string, unknown> };
        assertEquals(meta?.authorization, {
          channel: "call",
          note: "spoke with owner",
          revisionNumber: 3,
          subtotalCents: 12300,
        });
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("fence: draft -> approved walk-in edge fenced the same", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const rejected = await transition(order.id, "approved", ADMIN_ACTOR, {
          suppressNotification: true,
        });
        assertStrictEquals(rejected.ok, false);
        if (!rejected.ok) assertEquals(rejected.error.code, "invalid_input");

        const passed = await transition(order.id, "approved", ADMIN_ACTOR, {
          suppressNotification: true,
          authorization: { channel: "in_person" },
        });
        assertEquals(passed.ok, true);

        const events = await getEvents(order.id);
        const statusChange = events.find((e) => e.eventType === "status_change");
        const meta = statusChange?.metadata as { authorization?: { channel?: string } };
        assertEquals(meta?.authorization?.channel, "in_person");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("fence: customer approve auto-injects channel=portal", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        items: [sampleItem("Oil change", 9900)],
      });
      try {
        const result = await transition(
          order.id,
          "approved",
          { kind: "customer", customerId },
          { suppressNotification: true },
        );
        assertEquals(result.ok, true, "customer approval needs no evidence input");

        const events = await getEvents(order.id);
        const statusChange = events.find((e) => e.eventType === "status_change");
        const meta = statusChange?.metadata as { authorization?: Record<string, unknown> };
        assertEquals(meta?.authorization, {
          channel: "portal",
          revisionNumber: 1,
          subtotalCents: 9900,
        });
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("fence: staff-agent path fenced via resolved authority", async () => {
      const order = await insertTestOrder({ shopId, status: "estimated", customerId });
      try {
        const staffAgent: Actor = {
          kind: "agent",
          surface: "staff_chat",
          actingAs: ADMIN_ACTOR,
        };
        const rejected = await transition(order.id, "approved", staffAgent, {
          suppressNotification: true,
        });
        assertStrictEquals(rejected.ok, false, "staff agent must not bypass the fence");
        if (!rejected.ok) assertEquals(rejected.error.code, "invalid_input");

        const passed = await transition(order.id, "approved", staffAgent, {
          suppressNotification: true,
          authorization: { channel: "text" },
        });
        assertEquals(passed.ok, true);

        const events = await getEvents(order.id);
        const statusChange = events.find((e) => e.eventType === "status_change");
        assertEquals(statusChange?.actor, "agent(staff_chat)->admin:l2test@shop.com");
        const meta = statusChange?.metadata as { authorization?: { channel?: string } };
        assertEquals(meta?.authorization?.channel, "text");
      } finally {
        await deleteOrder(order.id);
      }
    });

    // -------------------------------------------------------------------
    // Chat-flow shortcut: draft accumulates slot + mechanic, then admin's
    // single "Approve & confirm" drives draft -> approved (fenced). The
    // schedule_ready marker fires on that approval (pair already complete).
    // -------------------------------------------------------------------

    await t.step("transition: admin draft -> approved (chat-flow Confirm)", async () => {
      const mech = await insertTestMechanic(shopId, { name: "chatflow-confirm" });
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        // Stamp scheduling fields first so the resulting `approved` order
        // is a complete booking (matches what `schedule_order` does in chat).
        const attached = await attachSchedule(order.id, {
          scheduledAt: futureDate(24),
          durationMinutes: 60,
          providerId: mech.id,
        }, ADMIN_ACTOR);
        assertEquals(attached.ok, true);

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "draft", "attachSchedule on draft preserves status");
        assertEquals(after.scheduledAt != null, true);
        assertEquals(
          (await getEvents(order.id)).filter((e) => e.eventType === "schedule_ready_notified")
            .length,
          0,
          "no confirmation email point while still draft",
        );

        // Admin's "Approve & confirm" — the only state mutation in the
        // chat-flow path. Fenced edge: needs authorization evidence.
        const result = await transition(order.id, "approved", ADMIN_ACTOR, {
          suppressNotification: true,
          authorization: { channel: "portal", note: "chat consent" },
        });
        assertEquals(result.ok, true, "draft -> approved allowed for admin");

        const final = await reloadOrder(order.id);
        assertEquals(final.status, "approved");

        const events = await getEvents(order.id);
        const draftToApproved = events.find(
          (e) =>
            e.eventType === "status_change" && e.fromStatus === "draft" &&
            e.toStatus === "approved",
        );
        assertEquals(draftToApproved != null, true, "emits draft->approved status_change");
        assertEquals(
          events.filter((e) => e.eventType === "schedule_ready_notified").length,
          1,
          "approval with complete pair reaches the confirmation email point",
        );
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("transition: customer can cancel draft (mid-chat walk-away)", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const customerActor: Actor = { kind: "customer", customerId };
        const result = await transition(order.id, "cancelled", customerActor, {
          reason: "changed mind",
        });
        assertEquals(result.ok, true, "customer.draft -> cancelled allowed");

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "cancelled");
        assertEquals(after.cancellationReason, "changed mind");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("transition: customer can cancel approved (booked) order", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        scheduledAt: futureDate(24),
      });
      try {
        const customerActor: Actor = { kind: "customer", customerId };
        const result = await transition(order.id, "cancelled", customerActor, {
          reason: "plans changed",
          suppressNotification: true,
        });
        assertEquals(result.ok, true, "customer.approved -> cancelled allowed");
        assertEquals((await reloadOrder(order.id)).status, "cancelled");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("autoAssignProvider: picks an eligible mechanic + emits event", async () => {
      // Ensure at least one eligible mechanic exists. Dev DB may also have
      // seeded providers; auto-assign picks any active mechanic with no
      // conflict, so we only verify behavior, not which specific row got
      // chosen.
      const mech = await insertTestMechanic(shopId, { name: "auto-assign-happy" });
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        // Set scheduling fields without assigning anyone.
        const attached = await attachSchedule(order.id, {
          scheduledAt: futureDate(48),
          durationMinutes: 60,
        }, ADMIN_ACTOR);
        assertEquals(attached.ok, true);

        const outcome = await autoAssignProvider(order.id);
        assertEquals(typeof outcome.providerId, "number", "picks some eligible mechanic");
        assertEquals(outcome.providerId != null, true);

        const after = await reloadOrder(order.id);
        assertEquals(after.providerId, outcome.providerId, "writes picked id to order");

        const events = await getEvents(order.id);
        const assigned = events.find((e) => e.eventType === "provider_assigned");
        assertEquals(assigned != null, true, "emits provider_assigned audit row");
        assertEquals(assigned?.actor, "system:auto_dispatch");
        // Draft order — pair completion must NOT fire the confirmation email.
        assertEquals(
          events.filter((e) => e.eventType === "schedule_ready_notified").length,
          0,
          "no schedule_ready on a draft",
        );
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("autoAssignProvider: returns null on order with no scheduling", async () => {
      const mech = await insertTestMechanic(shopId, { name: "auto-assign-no-time" });
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const outcome = await autoAssignProvider(order.id);
        assertStrictEquals(outcome.providerId, null);
        assertEquals(outcome.reason, "order is not scheduled");

        const after = await reloadOrder(order.id);
        assertStrictEquals(after.providerId, null, "no providerId written");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("autoAssignProvider: skips when already assigned", async () => {
      const mech = await insertTestMechanic(shopId, { name: "auto-assign-already" });
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        const attached = await attachSchedule(order.id, {
          scheduledAt: futureDate(72),
          durationMinutes: 60,
          providerId: mech.id,
        }, ADMIN_ACTOR);
        assertEquals(attached.ok, true);

        const outcome = await autoAssignProvider(order.id);
        assertEquals(outcome.providerId, mech.id);
        assertEquals(outcome.reason, "already assigned");

        const events = await getEvents(order.id);
        const assigned = events.filter((e) => e.eventType === "provider_assigned");
        assertEquals(assigned.length, 0, "no extra provider_assigned event");
      } finally {
        await deleteOrder(order.id);
        await deleteMechanic(mech.id);
      }
    });

    await t.step("notifyMechanic: resolves the assigned mechanic's email", async () => {
      const withEmail = await insertTestMechanic(shopId, { email: "mech@hmls.local" });
      const noEmail = await insertTestMechanic(shopId, { email: null });
      const assigned = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        providerId: withEmail.id,
        scheduledAt: futureDate(48),
      });
      const unassigned = await insertTestOrder({ shopId, status: "approved", customerId });
      const noEmailOrder = await insertTestOrder({
        shopId,
        status: "approved",
        customerId,
        providerId: noEmail.id,
      });
      try {
        // Resolves provider.email → dispatch attempted (Resend unset in test,
        // but resolution reached the send path).
        assertEquals(await notifyMechanic(assigned.id, "assigned"), "sent");
        // No mechanic on the order → nobody to notify.
        assertEquals(await notifyMechanic(unassigned.id, "cancelled"), "no-recipient");
        // Mechanic assigned but has no email on file → skip, don't throw.
        assertEquals(await notifyMechanic(noEmailOrder.id, "rescheduled"), "no-recipient");
        // Unknown order id → not-found, never throws.
        assertEquals(await notifyMechanic(2_000_000_000, "assigned"), "not-found");
        // Reassignment: the override targets the PREVIOUS mechanic (withEmail)
        // even though the order row now points at a different current mechanic.
        assertEquals(
          await notifyMechanic(noEmailOrder.id, "unassigned", withEmail.id),
          "sent",
        );
      } finally {
        await deleteOrder(assigned.id);
        await deleteOrder(unassigned.id);
        await deleteOrder(noEmailOrder.id);
        await deleteMechanic(withEmail.id);
        await deleteMechanic(noEmail.id);
      }
    });

    // Final safety sweep in case any step crashed mid-try.
    await sweepStaleFixtures();
  },
});
