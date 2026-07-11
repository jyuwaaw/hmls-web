import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@hmls/agent/db";
import { mechanic } from "./mechanic.ts";

// The 401 path short-circuits before any DB call runs — no env vars needed.
// Registered first so it runs before the DB test flips SKIP_AUTH on.

Deno.test("mechanic: rejects missing Authorization header", async () => {
  const res = await mechanic.request("/orders/1/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "in_progress" }),
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error.code, "UNAUTHORIZED");
});

// ---------------------------------------------------------------------------
// DB-backed tests for POST /orders/:id/transition. Hit the real Postgres
// behind DATABASE_URL and skip cleanly when it's unset (CI / pure-L1 runs).
//
// Run locally against the LOCAL Supabase (never prod):
//   supabase start
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     deno test -A apps/gateway/src/routes/mechanic_test.ts
//
// Auth is exercised via the middleware's SKIP_AUTH dev path so the full
// requireMechanic → requireShopContext → withTenantTx chain still runs.
// ---------------------------------------------------------------------------

const DATABASE_URL = Deno.env.get("DATABASE_URL");

const SLUG_A = "mech-transition-test-a";
const SLUG_B = "mech-transition-test-b";
const MARKER = "[mech-transition-test]";

async function ensureShop(slug: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.shops.id })
    .from(schema.shops)
    .where(eq(schema.shops.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.shops)
    .values({ name: `${MARKER} ${slug}`, slug })
    .returning({ id: schema.shops.id });
  return created.id;
}

async function sweep(shopIds: string[]) {
  // orders cascade to order_events; providers/customers are FK'd to shops.
  await db.delete(schema.orders).where(inArray(schema.orders.shopId, shopIds));
  await db.delete(schema.providers).where(inArray(schema.providers.shopId, shopIds));
  await db.delete(schema.customers).where(inArray(schema.customers.shopId, shopIds));
}

async function transitionReq(
  orderId: number,
  body: { to: string; confirmedDiagnosis?: string },
): Promise<Response> {
  return await mechanic.request(`/orders/${orderId}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "mechanic: POST /orders/:id/transition (DB)",
  ignore: !DATABASE_URL,
  // Shared postgres pool + fire-and-forget notification skips leak async ops.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const shopA = await ensureShop(SLUG_A);
    const shopB = await ensureShop(SLUG_B);
    await sweep([shopA, shopB]);

    const [me] = await db
      .insert(schema.providers)
      .values({ shopId: shopA, name: `${MARKER} me` })
      .returning();
    const [other] = await db
      .insert(schema.providers)
      .values({ shopId: shopA, name: `${MARKER} other` })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ shopId: shopA, name: `${MARKER} customer` })
      .returning();

    const approvedOrder = (shopId: string, providerId: number) => ({
      shopId,
      customerId: customer.id,
      providerId,
      status: "approved" as const,
      statusHistory: [
        { status: "approved", timestamp: new Date().toISOString(), actor: "test:fixture" },
      ],
    });

    const [mine] = await db.insert(schema.orders).values(approvedOrder(shopA, me.id)).returning();
    const [others] = await db.insert(schema.orders).values(approvedOrder(shopA, other.id))
      .returning();
    // Cross-shop: assigned to "me" but in another shop — must 404 via shop scope.
    const [crossShop] = await db.insert(schema.orders).values(approvedOrder(shopB, me.id))
      .returning();

    // SKIP_AUTH dev path: middleware resolves providerId/shopId from these.
    const prevEnv = {
      SKIP_AUTH: Deno.env.get("SKIP_AUTH"),
      DEV_PROVIDER_ID: Deno.env.get("DEV_PROVIDER_ID"),
      DEV_SHOP_ID: Deno.env.get("DEV_SHOP_ID"),
    };
    Deno.env.set("SKIP_AUTH", "true");
    Deno.env.set("DEV_PROVIDER_ID", String(me.id));
    Deno.env.set("DEV_SHOP_ID", shopA);

    try {
      await t.step("own approved order -> in_progress OK, mechanic actor stamped", async () => {
        const res = await transitionReq(mine.id, { to: "in_progress" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.status, "in_progress");
        const last = body.statusHistory.at(-1);
        assertEquals(last.status, "in_progress");
        assertEquals(last.actor, `mechanic:${me.id}`);
      });

      await t.step("duplicate transition -> conflict error shape", async () => {
        // Double-click: the state guard rejects the second in_progress.
        const res = await transitionReq(mine.id, { to: "in_progress" });
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "BAD_REQUEST");
        assertStringIncludes(body.error.message, "in_progress");
      });

      await t.step("complete with confirmedDiagnosis persists it", async () => {
        const res = await transitionReq(mine.id, {
          to: "completed",
          confirmedDiagnosis: "Worn serpentine belt",
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.status, "completed");
        const [row] = await db
          .select({ confirmedDiagnosis: schema.orders.confirmedDiagnosis })
          .from(schema.orders)
          .where(eq(schema.orders.id, mine.id))
          .limit(1);
        assertEquals(row.confirmedDiagnosis, "Worn serpentine belt");
      });

      await t.step("other provider's order -> 404", async () => {
        const res = await transitionReq(others.id, { to: "in_progress" });
        assertEquals(res.status, 404);
        const body = await res.json();
        assertEquals(body.error.code, "NOT_FOUND");
        // Untouched — the 404 short-circuited before any write.
        const [row] = await db
          .select({ status: schema.orders.status })
          .from(schema.orders)
          .where(eq(schema.orders.id, others.id))
          .limit(1);
        assertEquals(row.status, "approved");
      });

      await t.step("cross-shop order (assigned to me) -> 404", async () => {
        const res = await transitionReq(crossShop.id, { to: "in_progress" });
        assertEquals(res.status, 404);
        const [row] = await db
          .select({ status: schema.orders.status })
          .from(schema.orders)
          .where(eq(schema.orders.id, crossShop.id))
          .limit(1);
        assertEquals(row.status, "approved");
      });
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await sweep([shopA, shopB]);
      await db.delete(schema.shops).where(inArray(schema.shops.id, [shopA, shopB]));
    }
  },
});

// ---------------------------------------------------------------------------
// POST /orders/:id/payment — mechanic on-the-spot collection (PR 4)
// ---------------------------------------------------------------------------

async function paymentReq(
  orderId: number,
  body: Record<string, unknown>,
): Promise<Response> {
  return await mechanic.request(`/orders/${orderId}/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "mechanic: POST /orders/:id/payment (DB)",
  ignore: !DATABASE_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const shopA = await ensureShop(SLUG_A);
    const shopB = await ensureShop(SLUG_B);
    await sweep([shopA, shopB]);

    const [me] = await db
      .insert(schema.providers)
      .values({ shopId: shopA, name: `${MARKER} me` })
      .returning();
    const [other] = await db
      .insert(schema.providers)
      .values({ shopId: shopA, name: `${MARKER} other` })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ shopId: shopA, name: `${MARKER} customer` })
      .returning();

    const orderIn = (
      shopId: string,
      providerId: number,
      status: "completed" | "in_progress",
    ) => ({
      shopId,
      customerId: customer.id,
      providerId,
      status,
      statusHistory: [
        { status, timestamp: new Date().toISOString(), actor: "test:fixture" },
      ],
    });

    const [mine] = await db.insert(schema.orders).values(orderIn(shopA, me.id, "completed"))
      .returning();
    const [others] = await db.insert(schema.orders).values(orderIn(shopA, other.id, "completed"))
      .returning();
    const [crossShop] = await db.insert(schema.orders).values(orderIn(shopB, me.id, "completed"))
      .returning();
    const [notDone] = await db.insert(schema.orders).values(orderIn(shopA, me.id, "in_progress"))
      .returning();

    const prevEnv = {
      SKIP_AUTH: Deno.env.get("SKIP_AUTH"),
      DEV_PROVIDER_ID: Deno.env.get("DEV_PROVIDER_ID"),
      DEV_SHOP_ID: Deno.env.get("DEV_SHOP_ID"),
    };
    Deno.env.set("SKIP_AUTH", "true");
    Deno.env.set("DEV_PROVIDER_ID", String(me.id));
    Deno.env.set("DEV_SHOP_ID", shopA);

    try {
      await t.step("own completed order: payment stamped, collectedBy in event", async () => {
        const res = await paymentReq(mine.id, {
          amountCents: 25000,
          method: "cash",
          reference: "receipt-9",
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.paymentMethod, "cash");
        assertEquals(body.paidAmountCents, 25000);
        assertEquals(body.paymentReference, "receipt-9");
        assertEquals(body.paidAt != null, true);

        const events = await db
          .select()
          .from(schema.orderEvents)
          .where(eq(schema.orderEvents.orderId, mine.id));
        const payments = events.filter((e) => e.eventType === "payment_recorded");
        assertEquals(payments.length, 1);
        assertEquals(payments[0].actor, `mechanic:${me.id}`);
        const meta = payments[0].metadata as { collectedBy?: number; amountCents?: number };
        assertEquals(meta.collectedBy, me.id);
        assertEquals(meta.amountCents, 25000);
      });

      await t.step("repeat submission overwrites, no stacking of columns", async () => {
        const res = await paymentReq(mine.id, { amountCents: 26000, method: "zelle" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.paidAmountCents, 26000);
        assertEquals(body.paymentMethod, "zelle");
        assertEquals(body.paymentReference, null);
      });

      await t.step("other provider's completed order -> 404, untouched", async () => {
        const res = await paymentReq(others.id, { amountCents: 100, method: "cash" });
        assertEquals(res.status, 404);
        const [row] = await db
          .select({ paidAt: schema.orders.paidAt })
          .from(schema.orders)
          .where(eq(schema.orders.id, others.id))
          .limit(1);
        assertEquals(row.paidAt, null);
      });

      await t.step("cross-shop order (assigned to me) -> 404", async () => {
        const res = await paymentReq(crossShop.id, { amountCents: 100, method: "cash" });
        assertEquals(res.status, 404);
      });

      await t.step("wrong status (in_progress) -> 400, untouched", async () => {
        const res = await paymentReq(notDone.id, { amountCents: 100, method: "cash" });
        assertEquals(res.status, 400);
        const body = await res.json();
        assertStringIncludes(body.error.message, "completed");
        const [row] = await db
          .select({ paidAt: schema.orders.paidAt })
          .from(schema.orders)
          .where(eq(schema.orders.id, notDone.id))
          .limit(1);
        assertEquals(row.paidAt, null);
      });

      await t.step("invalid method rejected by shared contract", async () => {
        const res = await paymentReq(mine.id, { amountCents: 100, method: "transfer" });
        assertEquals(res.status, 400);
      });
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await sweep([shopA, shopB]);
      await db.delete(schema.shops).where(inArray(schema.shops.id, [shopA, shopB]));
    }
  },
});
