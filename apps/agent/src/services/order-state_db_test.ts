// L2 DB tests for the order-state harness. Exercises invariants that the
// pure L1 suite cannot: transactional atomicity, optimistic concurrency,
// multi-event writes, trigger interactions, actor string stamping.
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
// Run locally:
//   infisical run --env=dev -- deno test -A \
//     apps/agent/src/services/order-state_db_test.ts

import { assertEquals, assertStrictEquals } from "@std/assert";
import { desc, eq, like } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { addNote, attachSchedule, patchItems, recordPayment, transition } from "./order-state.ts";
import { autoAssignProvider } from "./auto-assign.ts";
import type { Actor, OrderStatus } from "@hmls/shared/order/status";
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
  opts: { name?: string; isActive?: boolean } = {},
): Promise<typeof schema.providers.$inferSelect> {
  const [row] = await db
    .insert(schema.providers)
    .values({
      shopId,
      name: `${TEST_MARKER} ${opts.name ?? crypto.randomUUID().slice(0, 8)}`,
      isActive: opts.isActive ?? true,
    })
    .returning();
  return row;
}

async function deleteMechanic(id: number): Promise<void> {
  await db.delete(schema.providers).where(eq(schema.providers.id, id));
}

async function insertTestOrder(opts: {
  shopId: string;
  status: OrderStatus;
  customerId: number;
  items?: OrderItem[];
  revisionNumber?: number;
}): Promise<typeof schema.orders.$inferSelect> {
  const items = opts.items ?? [];
  const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
  const [row] = await db
    .insert(schema.orders)
    .values({
      shopId: opts.shopId,
      customerId: opts.customerId,
      status: opts.status,
      statusHistory: [{
        status: opts.status,
        timestamp: new Date().toISOString(),
        actor: "test_setup",
      }],
      items,
      subtotalCents,
      revisionNumber: opts.revisionNumber ?? 1,
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
      const order = await insertTestOrder({ shopId, status: "approved", customerId });
      try {
        // Customer cannot drive approved -> scheduled — only admin can.
        const customerActor: Actor = { kind: "customer", customerId };
        const result = await transition(order.id, "scheduled", customerActor, {
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

    await t.step("patchItems: estimated auto-flips to revised, emits 2 events", async () => {
      const order = await insertTestOrder({
        shopId,
        status: "estimated",
        customerId,
        items: [sampleItem("Original service", 10000)],
      });
      try {
        const newItems = [sampleItem("Revised service", 15000)];
        const result = await patchItems(order.id, { items: newItems }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "revised", "status should flip to revised");
        assertEquals(updated.subtotalCents, 15000, "subtotal recomputed from items");
        assertEquals(updated.revisionNumber, 2, "revisionNumber bumped");

        const events = await getEvents(order.id);
        const itemsEdited = events.filter((e) => e.eventType === "items_edited");
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(itemsEdited.length, 1, "one items_edited event");
        assertEquals(statusChange.length, 1, "one status_change event for the flip");
        assertEquals(statusChange[0].fromStatus, "estimated");
        assertEquals(statusChange[0].toStatus, "revised");
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

    await t.step("patchItems: autoRevertEstimatedToRevised=false stays in estimated", async () => {
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
          { autoRevertEstimatedToRevised: false },
        );
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "estimated", "status preserved when autoRevert disabled");

        const events = await getEvents(order.id);
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(statusChange.length, 0, "no status_change event when flip disabled");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("attachSchedule: approved -> scheduled advances + emits both events", async () => {
      const order = await insertTestOrder({ shopId, status: "approved", customerId });
      try {
        const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const result = await attachSchedule(order.id, {
          scheduledAt,
          durationMinutes: 90,
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "scheduled");
        assertEquals(updated.durationMinutes, 90);
        assertEquals(
          updated.blockedRange != null,
          true,
          "compute_blocked_range trigger should populate blocked_range",
        );

        const events = await getEvents(order.id);
        const scheduleAttached = events.find((e) => e.eventType === "schedule_attached");
        const statusChange = events.find((e) => e.eventType === "status_change");
        assertEquals(scheduleAttached != null, true);
        assertEquals(statusChange != null, true);
        assertEquals(statusChange?.toStatus, "scheduled");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("attachSchedule: on estimated order is status-preserving", async () => {
      const order = await insertTestOrder({ shopId, status: "estimated", customerId });
      try {
        const result = await attachSchedule(order.id, {
          scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          durationMinutes: 60,
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true, "estimated should accept schedule attach");

        const updated = await reloadOrder(order.id);
        assertEquals(updated.status, "estimated", "status preserved on pre-approval booking");
        assertEquals(updated.scheduledAt != null, true);

        const events = await getEvents(order.id);
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(statusChange.length, 0, "no status_change on pre-approval booking");
        const scheduleAttached = events.filter((e) => e.eventType === "schedule_attached");
        assertEquals(scheduleAttached.length, 1);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("attachSchedule: on scheduled order is a pure field update", async () => {
      const order = await insertTestOrder({ shopId, status: "scheduled", customerId });
      try {
        const result = await attachSchedule(order.id, {
          scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
          durationMinutes: 120,
        }, ADMIN_ACTOR);
        assertEquals(result.ok, true);

        const events = await getEvents(order.id);
        const statusChange = events.filter((e) => e.eventType === "status_change");
        assertEquals(statusChange.length, 0, "no status_change on reschedule");
        const scheduleAttached = events.filter((e) => e.eventType === "schedule_attached");
        assertEquals(scheduleAttached.length, 1);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("recordPayment: stamps paidAt/method/reference on scheduled order", async () => {
      const order = await insertTestOrder({ shopId, status: "scheduled", customerId });
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
    // Chat-flow shortcut: draft -> scheduled (admin Confirm) +
    // auto-dispatch behavior. Exercises the new lifecycle path shipped
    // in the one-shot booking change.
    // -------------------------------------------------------------------

    await t.step("transition: admin draft -> scheduled (chat-flow Confirm)", async () => {
      const order = await insertTestOrder({ shopId, status: "draft", customerId });
      try {
        // Stamp scheduling fields first so the resulting `scheduled` order
        // is well-formed (matches what `schedule_order` does in the chat).
        const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const attached = await attachSchedule(order.id, {
          scheduledAt,
          durationMinutes: 60,
        }, ADMIN_ACTOR);
        assertEquals(attached.ok, true);

        const after = await reloadOrder(order.id);
        assertEquals(after.status, "draft", "attachSchedule on draft preserves status");
        assertEquals(after.scheduledAt != null, true);

        // Admin's "Confirm booking" — the only state mutation in the
        // chat-flow path.
        const result = await transition(order.id, "scheduled", ADMIN_ACTOR);
        assertEquals(result.ok, true, "draft -> scheduled allowed for admin");

        const final = await reloadOrder(order.id);
        assertEquals(final.status, "scheduled");

        const events = await getEvents(order.id);
        const statusChanges = events.filter((e) => e.eventType === "status_change");
        const draftToScheduled = statusChanges.find(
          (e) => e.fromStatus === "draft" && e.toStatus === "scheduled",
        );
        assertEquals(draftToScheduled != null, true, "emits draft->scheduled status_change");
      } finally {
        await deleteOrder(order.id);
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
          scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
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
          scheduledAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
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

    // Final safety sweep in case any step crashed mid-try.
    await sweepStaleFixtures();
  },
});
