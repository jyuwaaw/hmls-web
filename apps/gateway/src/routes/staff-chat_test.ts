import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@hmls/agent/db";
import { formatOrderContext, loadOrderContext, staffChat } from "./staff-chat.ts";

// The 401 path short-circuits before any agent/db call runs — no env needed.
// Registered first so it runs before the DB tests flip SKIP_AUTH on.

Deno.test("staff-chat: rejects request with no Authorization header", async () => {
  const res = await staffChat.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error.code, "UNAUTHORIZED");
});

// ---------------------------------------------------------------------------
// formatOrderContext — pure, no DB.
// ---------------------------------------------------------------------------

function fakeOrder(
  overrides: Partial<typeof schema.orders.$inferSelect> = {},
): typeof schema.orders.$inferSelect {
  return {
    id: 42,
    status: "approved",
    revisionNumber: 2,
    contactName: "Jane Doe",
    contactPhone: "555-1234",
    vehicleInfo: { year: "2020", make: "Toyota", model: "Camry" },
    items: [
      {
        id: "i1",
        category: "labor",
        name: "Front brake pads",
        quantity: 1,
        unitPriceCents: 28000,
        totalCents: 28000,
        taxable: false,
      },
    ],
    subtotalCents: 28000,
    scheduledAt: new Date("2026-07-12T17:00:00Z"),
    durationMinutes: 90,
    location: "123 Main St",
    providerId: 7,
    paidAt: null,
    paidAmountCents: null,
    paymentMethod: null,
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("formatOrderContext: includes id, status, customer, vehicle, items, schedule, mechanic", () => {
  const ctx = formatOrderContext(fakeOrder(), "Jake");
  assertStringIncludes(ctx, "Order #42");
  assertStringIncludes(ctx, "approved (revision 2)");
  assertStringIncludes(ctx, "Jane Doe · 555-1234");
  assertStringIncludes(ctx, "2020 Toyota Camry");
  assertStringIncludes(ctx, "Front brake pads (labor) x1 @ $280.00");
  assertStringIncludes(ctx, "subtotal $280.00");
  assertStringIncludes(ctx, "2026-07-12T17:00:00.000Z (90 min) at 123 Main St");
  assertStringIncludes(ctx, "Jake (#7)");
  assertStringIncludes(ctx, "Payment: unpaid");
});

Deno.test("formatOrderContext: canonicalizes legacy status + shows paid state", () => {
  const ctx = formatOrderContext(
    fakeOrder({
      status: "scheduled", // window-period legacy label → approved
      paidAt: new Date("2026-07-13T00:00:00Z"),
      paidAmountCents: 28000,
      paymentMethod: "cash",
      providerId: null,
      scheduledAt: null,
      // deno-lint-ignore no-explicit-any
    } as any),
    null,
  );
  assertStringIncludes(ctx, "Status: approved");
  assertStringIncludes(ctx, "paid $280.00 (cash)");
  assertStringIncludes(ctx, "Mechanic: unassigned");
  assertStringIncludes(ctx, "Schedule: not scheduled");
});

// ---------------------------------------------------------------------------
// DB-backed tests: the orderId seed guard. Hit the real Postgres behind
// DATABASE_URL and skip cleanly when it's unset (CI / pure-L1 runs).
//
// Run locally against the LOCAL Supabase (never prod):
//   supabase start
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     deno test -A apps/gateway/src/routes/staff-chat_test.ts
//
// Auth is exercised via the middleware's SKIP_AUTH dev path so the full
// requireAdmin → requireShopContext chain still runs.
// ---------------------------------------------------------------------------

const DATABASE_URL = Deno.env.get("DATABASE_URL");

const SLUG_A = "staff-chat-seed-test-a";
const SLUG_B = "staff-chat-seed-test-b";
const MARKER = "[staff-chat-seed-test]";

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
  await db.delete(schema.orders).where(inArray(schema.orders.shopId, shopIds));
  await db.delete(schema.providers).where(inArray(schema.providers.shopId, shopIds));
  await db.delete(schema.customers).where(inArray(schema.customers.shopId, shopIds));
}

async function chatReq(orderId: unknown): Promise<Response> {
  return await staffChat.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
      orderId,
    }),
  });
}

Deno.test({
  name: "staff-chat: orderId seed guard (DB)",
  ignore: !DATABASE_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const shopA = await ensureShop(SLUG_A);
    const shopB = await ensureShop(SLUG_B);
    await sweep([shopA, shopB]);

    const [customer] = await db
      .insert(schema.customers)
      .values({ shopId: shopA, name: `${MARKER} customer` })
      .returning();
    const [mech] = await db
      .insert(schema.providers)
      .values({ shopId: shopA, name: `${MARKER} Jake` })
      .returning();
    const [mine] = await db
      .insert(schema.orders)
      .values({
        shopId: shopA,
        customerId: customer.id,
        providerId: mech.id,
        status: "approved",
        contactName: `${MARKER} Jane`,
        subtotalCents: 28000,
      })
      .returning();
    // Cross-shop order — must 404 for a shop-A staff session.
    const [customerB] = await db
      .insert(schema.customers)
      .values({ shopId: shopB, name: `${MARKER} customer B` })
      .returning();
    const [foreign] = await db
      .insert(schema.orders)
      .values({ shopId: shopB, customerId: customerB.id, status: "draft" })
      .returning();

    const prevEnv = {
      SKIP_AUTH: Deno.env.get("SKIP_AUTH"),
      DEV_SHOP_ID: Deno.env.get("DEV_SHOP_ID"),
      DEEPSEEK_API_KEY: Deno.env.get("DEEPSEEK_API_KEY"),
    };
    Deno.env.set("SKIP_AUTH", "true");
    Deno.env.set("DEV_SHOP_ID", shopA);
    // Unset the model key so a request that PASSES the seed guard fails fast
    // and deterministically inside runStaffAgent (500 AGENT_ERROR) instead of
    // opening a live model stream from a unit test.
    Deno.env.delete("DEEPSEEK_API_KEY");

    try {
      await t.step("cross-shop orderId -> 404 before streaming", async () => {
        const res = await chatReq(foreign.id);
        assertEquals(res.status, 404);
        const body = await res.json();
        assertEquals(body.error.code, "NOT_FOUND");
      });

      await t.step("nonexistent orderId -> 404", async () => {
        const res = await chatReq(999_999_999);
        assertEquals(res.status, 404);
        const body = await res.json();
        assertEquals(body.error.code, "NOT_FOUND");
      });

      await t.step("malformed orderId -> 404 (same shape, no leak)", async () => {
        const res = await chatReq("not-a-number");
        assertEquals(res.status, 404);
        const body = await res.json();
        assertEquals(body.error.code, "NOT_FOUND");
      });

      await t.step("same-shop orderId passes the guard (reaches the agent)", async () => {
        const res = await chatReq(mine.id);
        // Guard passed → runStaffAgent throws on the missing key → AGENT_ERROR,
        // NOT the 404 the guard produces.
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.error.code, "AGENT_ERROR");
        assertStringIncludes(body.error.message, "DEEPSEEK_API_KEY");
      });

      await t.step("loadOrderContext: same-shop order -> formatted seed", async () => {
        const ctx = await loadOrderContext(mine.id, shopA);
        assertEquals(typeof ctx, "string");
        assertStringIncludes(ctx!, `Order #${mine.id}`);
        assertStringIncludes(ctx!, "Status: approved");
        assertStringIncludes(ctx!, `${MARKER} Jane`);
        assertStringIncludes(ctx!, `${MARKER} Jake (#${mech.id})`);
        assertStringIncludes(ctx!, "subtotal $280.00");
      });

      await t.step("loadOrderContext: cross-shop -> null", async () => {
        assertEquals(await loadOrderContext(foreign.id, shopA), null);
      });

      await t.step("loadOrderContext: owner all-shops -> may read any shop", async () => {
        const ctx = await loadOrderContext(foreign.id, "__all__");
        assertStringIncludes(ctx!, `Order #${foreign.id}`);
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
