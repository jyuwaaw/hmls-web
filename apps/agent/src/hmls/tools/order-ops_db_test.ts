// L2 DB tests for the staff order-ops tools (assign_mechanic /
// record_payment). Exercises what the pure L1 suite cannot: real provider
// resolution, shop scoping via orderAccessible, the re-dispatch confirmation
// fence against a persisted assignment, and payment column writes.
//
// Hits the real Postgres behind DATABASE_URL; skips cleanly if unset.
//
// Run locally against the LOCAL Supabase (never prod):
//   supabase start
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     deno test -A apps/agent/src/hmls/tools/order-ops_db_test.ts

import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq, like } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { staffOrderOpsTools } from "./order-ops.ts";
import type { LegacyTool, ToolContext } from "../../common/convert-tools.ts";
import type { PhysicalOrderStatus } from "@hmls/shared/order/status";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

const assignMechanic: LegacyTool = staffOrderOpsTools.find((t) => t.name === "assign_mechanic")!;
const recordPayment: LegacyTool = staffOrderOpsTools.find((t) => t.name === "record_payment")!;

// deno-lint-ignore no-explicit-any
type ToolRes = { success: boolean; error?: string } & Record<string, any>;

const TEST_MARKER = "[order-ops-tool-test]";
const TEST_CUSTOMER_EMAIL = "order-ops-tool-test@hmls.local";

async function ensureShop(slug: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.shops)
    .where(eq(schema.shops.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.shops)
    .values({ name: `${TEST_MARKER} ${slug}`, slug })
    .returning({ id: schema.shops.id });
  return created.id;
}

async function ensureCustomer(shopId: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.email, TEST_CUSTOMER_EMAIL))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.customers)
    .values({ shopId, name: `${TEST_MARKER} customer`, email: TEST_CUSTOMER_EMAIL })
    .returning();
  return created.id;
}

async function sweepStaleFixtures(): Promise<void> {
  await db.delete(schema.orders).where(like(schema.orders.contactName, `${TEST_MARKER}%`));
  await db.delete(schema.providers).where(like(schema.providers.name, `${TEST_MARKER}%`));
}

async function insertMechanic(
  shopId: string,
  name: string,
  opts: { isActive?: boolean } = {},
): Promise<typeof schema.providers.$inferSelect> {
  const [row] = await db
    .insert(schema.providers)
    .values({ shopId, name: `${TEST_MARKER} ${name}`, isActive: opts.isActive ?? true })
    .returning();
  return row;
}

async function insertOrder(opts: {
  shopId: string;
  customerId: number;
  status: PhysicalOrderStatus;
  providerId?: number | null;
}): Promise<typeof schema.orders.$inferSelect> {
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
      items: [],
      subtotalCents: 0,
      providerId: opts.providerId ?? null,
      shareToken: crypto.randomUUID().replace(/-/g, ""),
      contactName: `${TEST_MARKER} ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row;
}

async function reloadOrder(orderId: number) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  return row;
}

async function deleteOrder(orderId: number): Promise<void> {
  await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
}

Deno.test({
  name: "order-ops staff tools L2 DB suite",
  sanitizeOps: false,
  sanitizeResources: false,
  ignore: !DATABASE_URL,
  async fn(t) {
    await sweepStaleFixtures();
    const shopId = await ensureShop("order-ops-tool-test");
    const otherShopId = await ensureShop("order-ops-tool-test-other");
    const customerId = await ensureCustomer(shopId);
    const staffCtx: ToolContext = { shopId, adminEmail: "opstest@shop.com" };

    const jake = await insertMechanic(shopId, "Jake Alpha");
    const maria = await insertMechanic(shopId, "Maria Beta");
    await insertMechanic(shopId, "Jason Gamma"); // 'Ja' collides with Jake (ambiguity fixture)

    await t.step("assign_mechanic: assigns by providerId", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerId: jake.id },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, true, res.error);
        assertEquals((await reloadOrder(order.id)).providerId, jake.id);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: resolves a unique name substring", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerName: "Maria" },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, true, res.error);
        assertEquals(res.providerId, maria.id);
        assertStringIncludes(res.message, "Maria");
        assertEquals((await reloadOrder(order.id)).providerId, maria.id);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: ambiguous name lists candidates, no write", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        // "Ja" matches Jake Alpha AND Jason Gamma.
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerName: "Ja" },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "Ambiguous");
        assertStringIncludes(res.error!, "Jake Alpha");
        assertStringIncludes(res.error!, "Jason Gamma");
        assertEquals((await reloadOrder(order.id)).providerId, null);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: unknown name lists the active roster", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerName: "Zebulon" },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "No mechanic matching");
        assertStringIncludes(res.error!, "Jake Alpha");
        assertStringIncludes(res.error!, "Maria Beta");
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: re-dispatch without confirmReassign rejected", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft", providerId: jake.id });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerId: maria.id },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "already assigned");
        assertStringIncludes(res.error!, "Jake Alpha");
        assertStringIncludes(res.error!, "confirmReassign: true");
        assertEquals((await reloadOrder(order.id)).providerId, jake.id, "no write on rejection");

        const confirmed = await assignMechanic.execute(
          { orderId: String(order.id), providerId: maria.id, confirmReassign: true },
          staffCtx,
        ) as ToolRes;
        assertEquals(confirmed.success, true, confirmed.error);
        assertEquals((await reloadOrder(order.id)).providerId, maria.id);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: cross-shop order reads as not found", async () => {
      const order = await insertOrder({ shopId: otherShopId, customerId, status: "draft" });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerId: jake.id },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "not found");
        assertEquals((await reloadOrder(order.id)).providerId, null);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("assign_mechanic: cross-shop mechanic rejected by harness", async () => {
      const foreignMech = await insertMechanic(otherShopId, "Foreign Frank");
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        const res = await assignMechanic.execute(
          { orderId: String(order.id), providerId: foreignMech.id },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "different shop");
      } finally {
        await deleteOrder(order.id);
        await db.delete(schema.providers).where(eq(schema.providers.id, foreignMech.id));
      }
    });

    await t.step("record_payment: stamps payment columns + audit event", async () => {
      const order = await insertOrder({ shopId, customerId, status: "completed" });
      try {
        const res = await recordPayment.execute(
          {
            orderId: String(order.id),
            amountCents: 18000,
            method: "cash",
            reference: "till #2",
            confirmed: true,
          },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, true, res.error);

        const row = await reloadOrder(order.id);
        assertEquals(row.paidAmountCents, 18000);
        assertEquals(row.paymentMethod, "cash");
        assertEquals(row.paymentReference, "till #2");
        assertEquals(row.paidAt != null, true);

        const events = await db
          .select()
          .from(schema.orderEvents)
          .where(eq(schema.orderEvents.orderId, order.id));
        const paymentEvents = events.filter((e) => e.eventType === "payment_recorded");
        assertEquals(paymentEvents.length, 1);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("record_payment: draft order rejected by harness status gate", async () => {
      const order = await insertOrder({ shopId, customerId, status: "draft" });
      try {
        const res = await recordPayment.execute(
          { orderId: String(order.id), amountCents: 100, method: "cash", confirmed: true },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "draft");
        assertEquals((await reloadOrder(order.id)).paidAt, null);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await t.step("record_payment: cross-shop order reads as not found", async () => {
      const order = await insertOrder({ shopId: otherShopId, customerId, status: "completed" });
      try {
        const res = await recordPayment.execute(
          { orderId: String(order.id), amountCents: 100, method: "cash", confirmed: true },
          staffCtx,
        ) as ToolRes;
        assertEquals(res.success, false);
        assertStringIncludes(res.error!, "not found");
        assertEquals((await reloadOrder(order.id)).paidAt, null);
      } finally {
        await deleteOrder(order.id);
      }
    });

    await sweepStaleFixtures();
  },
});
