# Multi-tenancy (shop_id scoping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-shop tenant isolation — every admin/mechanic sees only their shop's orders/customers/mechanics, an `owner` sees all (with a switcher), and new orders route to the nearest shop by geocoded service address.

**Architecture:** Application-level scoping at the gateway (all data flows through one service-role connection; RLS deferred to Phase 2). A `requireShopContext` middleware resolves `ctx.shopId`; a `tenant.ts` choke point applies the filter; `create_order` geocodes the service address and stamps the routed `shopId`; pricing reads the shop's labor rate.

**Tech Stack:** Deno + Hono (gateway), Drizzle ORM over Supabase Postgres, AI SDK agent (Deno), Next.js 16 + React 19 web, drizzle-kit 0.31.9 migrations.

**Source spec:** `docs/superpowers/specs/2026-06-17-multi-tenancy-design.md`

> **PROD WARNING:** Infisical `--env=dev` connects to the **production** Supabase — there is no separate dev DB. The migration (Phase 0) is the only destructive step; its SQL must be shown to the user and approved before `db:migrate`. Backfill runs before `NOT NULL`.

---

## File Structure

**Create:**
- `apps/agent/migrations/0027_user_role_owner.sql` — enum value add (no txn wrapper)
- `apps/agent/migrations/0028_multi_tenancy.sql` — columns, seed shops, backfill, NOT NULL, indexes
- `apps/agent/src/db/tenant.ts` — scoped-read choke point (`whereShop`, `OWNER_ALL_SHOPS`, scoped repos)
- `apps/agent/src/db/tenant_test.ts` — L1 tests for `pickShopId`/`whereShop`
- `apps/agent/src/db/tenant_db_test.ts` — L2 isolation test
- `apps/gateway/src/middleware/shop-context.ts` — `requireShopContext` + `ShopEnv` + pure `pickShopId`
- `apps/gateway/src/middleware/shop-context_test.ts` — L1 tests for `pickShopId`
- `apps/agent/src/common/shop-routing.ts` — `geocodeAddress`, `nearestShop`, `routeOrderToShop`
- `apps/agent/src/common/shop-routing_test.ts` — L1 tests (nearestShop, parse)
- `apps/hmls-web/components/admin/ShopSwitcher.tsx` — owner shop dropdown
- `apps/hmls-web/hooks/useActiveShop.ts` — localStorage-backed active-shop state
- `apps/hmls-web/lib/active-shop.ts` + `apps/hmls-web/lib/active-shop.test.ts` — pure load/store helpers

**Modify:**
- `packages/shared/src/db/schema.ts` — `owner` enum value; `shops` lat/lng/serviceRadiusKm; `providers.shopId`; mark `customers/orders/providers.shopId` notNull
- `apps/gateway/src/middleware/auth.ts` — match customer by `authUserId` (email fallback)
- `apps/gateway/src/routes/{orders,admin,portal,admin-mechanics,mechanic,estimates}.ts` — apply shop scope
- `apps/gateway/src/routes/chat.ts` / `staff-chat.ts` — pass shopId to the agent run
- `apps/gateway/src/hmls-app.ts` — mount `requireShopContext`; add shops-list route
- `apps/agent/src/common/tools/order.ts` — route + stamp `shopId`; per-shop rate
- `apps/agent/src/hmls/skills/estimate/pricing.ts` — `getPricingConfig(shopId?)` reads shop rate
- `apps/hmls-web/lib/api-client.ts` — send `X-Shop-Id` header
- `apps/hmls-web/components/AuthProvider.tsx` — expose `isOwner`; thread active shop into the api client
- `apps/hmls-web/components/Navbar.tsx` — mount `<ShopSwitcher>` for owners

---

## Phase 0 — Schema & Migration

### Task 1: Schema changes (Drizzle source of truth)

**Files:**
- Modify: `packages/shared/src/db/schema.ts`

- [ ] **Step 1: Add `owner` to the role enum**

In `packages/shared/src/db/schema.ts`, change:
```typescript
export const userRoleEnum = pgEnum("user_role", ["customer", "admin", "mechanic"]);
```
to:
```typescript
export const userRoleEnum = pgEnum("user_role", ["customer", "admin", "mechanic", "owner"]);
```

- [ ] **Step 2: Add geo + radius columns to `shops`**

In the `shops` table definition, after `taxRatePercent`, add:
```typescript
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  serviceRadiusKm: integer("service_radius_km"),
```

- [ ] **Step 3: Add `shopId` to `providers`**

In the `providers` table, after `id`, add:
```typescript
  shopId: uuid("shop_id").references(() => shops.id).notNull(),
```

- [ ] **Step 4: Mark existing `shopId` columns NOT NULL**

In `customers`: change `shopId: uuid("shop_id").references(() => shops.id),` to
```typescript
  shopId: uuid("shop_id").references(() => shops.id).notNull(),
```
In `orders`: change `shopId: uuid("shop_id").references(() => shops.id),` to
```typescript
  shopId: uuid("shop_id").references(() => shops.id).notNull(),
```

- [ ] **Step 5: Add scoping indexes to the table config callbacks**

In `orders` table's index callback (the `(table) => ({...})` object), add:
```typescript
  shopStatusIdx: index("orders_shop_status_idx").on(table.shopId, table.status),
```
`customers` and `providers` have no index callback today; leave indexes to the SQL migration (Step in Task 3) to avoid restructuring the table definitions.

- [ ] **Step 6: Typecheck the schema package**

Run: `cd apps/hmls-web && bun run typecheck`
Expected: PASS (schema is consumed by web types). If `index` is not imported in schema.ts, add it to the `drizzle-orm/pg-core` import.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/db/schema.ts
git commit -m "feat(schema): multi-tenant columns (owner role, shop geo, providers.shopId, NOT NULL shopId)"
```

### Task 2: Enum migration (own file, no transaction)

**Files:**
- Create: `apps/agent/migrations/0027_user_role_owner.sql`

- [ ] **Step 1: Write the migration**

`apps/agent/migrations/0027_user_role_owner.sql`:
```sql
-- Add the 'owner' role (cross-shop super-admin). Standalone, no BEGIN/COMMIT:
-- ALTER TYPE ... ADD VALUE must not be used in the same transaction it is added.
-- 'owner' is NOT referenced anywhere else in this migration set's data steps.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'owner';
```

- [ ] **Step 2: Do NOT apply yet** — applied together in Task 3 Step 4 after review. Commit the file:

```bash
git add apps/agent/migrations/0027_user_role_owner.sql
git commit -m "feat(db): migration 0027 add owner role"
```

### Task 3: Foundation migration (create shops, backfill)

> **Correction (code review):** `SET NOT NULL` is **removed** from 0028 and deferred to a new final task **T16b** (migration `0029`). Marking `shopId` NOT NULL in Phase 0 broke existing `db.insert` calls (`deno task check` → 6 errors) because writes don't stamp `shopId` until Phases 1–3. 0028 still backfills existing rows to san-jose; the constraint lands after all write paths stamp shopId. The committed SQL is the source of truth (the block below shows the original intent — ignore its `SET NOT NULL` lines).

**Files:**
- Create: `apps/agent/migrations/0028_multi_tenancy.sql`

- [ ] **Step 1: Write the migration**

`apps/agent/migrations/0028_multi_tenancy.sql`:
```sql
-- Multi-tenancy foundation.
--   1. shops gets geo + radius columns
--   2. providers gets shop_id
--   3. create the first two shop rows (table is empty as of 2026-06-17):
--      san-jose (primary / backfill target) + orange-county
--   4. backfill all existing customers/orders/providers -> san-jose
--   5. lock shop_id NOT NULL on customers/orders/providers
--   6. scoping indexes
-- Seed labor_rate_cents = 14000 ($140/hr) = current global hourly_rate, so
-- per-shop pricing is a no-op on existing orders.

BEGIN;

-- 1. shops geo + radius
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS service_radius_km integer;

-- 2. providers.shop_id (nullable now; NOT NULL after backfill)
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES shops(id);

-- 3. seed the two shops
INSERT INTO shops (name, slug, timezone, labor_rate_cents, tax_rate_percent, latitude, longitude)
SELECT 'HMLS Mobile Mechanic — San Jose', 'san-jose', 'America/Los_Angeles', 14000, '0.0000', 37.3361663, -121.890591
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE slug = 'san-jose');

INSERT INTO shops (name, slug, timezone, labor_rate_cents, tax_rate_percent, latitude, longitude)
SELECT 'HMLS Mobile Mechanic — Orange County', 'orange-county', 'America/Los_Angeles', 14000, '0.0000', 33.6484505, -117.8365716
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE slug = 'orange-county');

-- 4. backfill everything to San Jose (the primary)
UPDATE customers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;
UPDATE orders    SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;
UPDATE providers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;

-- 5. lock NOT NULL
ALTER TABLE customers ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE orders    ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE providers ALTER COLUMN shop_id SET NOT NULL;

-- 6. scoping indexes
CREATE INDEX IF NOT EXISTS customers_shop_id_idx ON customers (shop_id);
CREATE INDEX IF NOT EXISTS providers_shop_id_idx ON providers (shop_id);
CREATE INDEX IF NOT EXISTS orders_shop_status_idx ON orders (shop_id, status);

COMMIT;
```
(`tax_rate_percent` seeded to `0.0000` — the engine applies no tax today; do not introduce one.)

- [ ] **Step 2: Commit the SQL (pre-apply)**

```bash
git add apps/agent/migrations/0028_multi_tenancy.sql
git commit -m "feat(db): migration 0028 multi-tenancy foundation + backfill"
```

- [ ] **Step 3: Show both migrations to the user and get explicit approval to apply to prod.** STOP here until approved.

- [ ] **Step 4: Apply migrations** — ⚠️ these hand-written SQL files are NOT tracked in the drizzle journal (`meta/_journal.json` only lists 0000 + 0016), so `deno task db:migrate` would **silently skip** them. Apply the SQL directly:

Run:
```bash
cd apps/agent && infisical run --env=dev -- bash -lc 'psql "$DATABASE_URL" -f migrations/0027_user_role_owner.sql && psql "$DATABASE_URL" -f migrations/0028_multi_tenancy.sql'
```
Expected: `ALTER TYPE` then `BEGIN`…`COMMIT`, no error.

- [ ] **Step 5: Verify backfill (zero NULLs, two shops)**

Run:
```bash
cd apps/agent && infisical run --env=dev -- bash -lc 'psql "$DATABASE_URL" -At -F" | " -c "
SELECT (SELECT count(*) FROM shops) shops,
       (SELECT count(*) FROM orders WHERE shop_id IS NULL) orders_null,
       (SELECT count(*) FROM customers WHERE shop_id IS NULL) cust_null,
       (SELECT count(*) FROM providers WHERE shop_id IS NULL) prov_null;"'
```
Expected: `2 | 0 | 0 | 0`

---

## Phase 1 — Shop-context middleware (gateway)

### Task 4: Pure `pickShopId` resolver + tests

**Files:**
- Create: `apps/gateway/src/middleware/shop-context.ts`
- Test: `apps/gateway/src/middleware/shop-context_test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/middleware/shop-context_test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { OWNER_ALL_SHOPS, pickShopId } from "./shop-context.ts";

const SJ = "11111111-1111-1111-1111-111111111111";
const OC = "22222222-2222-2222-2222-222222222222";

Deno.test("pickShopId: admin uses home shop, ignores header", () => {
  assertEquals(
    pickShopId({ role: "admin", homeShopId: SJ, headerShopId: OC, validShopIds: [SJ, OC] }),
    { shopId: SJ, isOwner: false },
  );
});

Deno.test("pickShopId: admin with no home shop is an error", () => {
  assertEquals(
    pickShopId({ role: "admin", homeShopId: null, headerShopId: null, validShopIds: [SJ] }),
    { error: "NO_SHOP" },
  );
});

Deno.test("pickShopId: owner with valid header scopes to it", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: OC, validShopIds: [SJ, OC] }),
    { shopId: OC, isOwner: true },
  );
});

Deno.test("pickShopId: owner with no header => all-shops sentinel", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: null, validShopIds: [SJ, OC] }),
    { shopId: OWNER_ALL_SHOPS, isOwner: true },
  );
});

Deno.test("pickShopId: owner with bogus header is an error", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: "nope", validShopIds: [SJ, OC] }),
    { error: "BAD_SHOP" },
  );
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `cd apps/gateway && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/middleware/shop-context_test.ts`
Expected: FAIL — module not found / `pickShopId` not exported.

- [ ] **Step 3: Write `shop-context.ts` (resolver only for now)**

`apps/gateway/src/middleware/shop-context.ts`:
```typescript
import type { Env } from "hono";
import { createMiddleware } from "hono/factory";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../lib/supabase.ts";

/** Sentinel: an owner with no selected shop — reads span all shops, writes are blocked. */
export const OWNER_ALL_SHOPS = "__all__";

export type ShopEnv = Env & {
  Variables: {
    authUser: AuthUser;
    shopId: string;
    isOwner: boolean;
  };
};

type PickInput = {
  role: string | null | undefined;
  homeShopId: string | null;
  headerShopId: string | null;
  validShopIds: string[];
};
type PickResult =
  | { shopId: string; isOwner: boolean }
  | { error: "NO_SHOP" | "BAD_SHOP" };

/** Pure shop-context decision. No DB / no I/O — unit tested. */
export function pickShopId(input: PickInput): PickResult {
  const { role, homeShopId, headerShopId, validShopIds } = input;
  if (role === "owner") {
    if (headerShopId == null) return { shopId: OWNER_ALL_SHOPS, isOwner: true };
    if (!validShopIds.includes(headerShopId)) return { error: "BAD_SHOP" };
    return { shopId: headerShopId, isOwner: true };
  }
  // customer / admin / mechanic: pinned to home shop, header ignored.
  if (homeShopId == null) return { error: "NO_SHOP" };
  return { shopId: homeShopId, isOwner: false };
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `cd apps/gateway && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/middleware/shop-context_test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/middleware/shop-context.ts apps/gateway/src/middleware/shop-context_test.ts
git commit -m "feat(gateway): pure pickShopId shop-context resolver"
```

### Task 5: `requireShopContext` middleware (DB wiring)

**Files:**
- Modify: `apps/gateway/src/middleware/shop-context.ts`

- [ ] **Step 1: Append the middleware**

Add to `apps/gateway/src/middleware/shop-context.ts`:
```typescript
async function loadValidShopIds(): Promise<string[]> {
  const rows = await db.select({ id: schema.shops.id }).from(schema.shops);
  return rows.map((r) => r.id);
}

/** Resolves ctx.shopId + ctx.isOwner. Mount AFTER requireAdmin/requireAuth/requireMechanic. */
export const requireShopContext = createMiddleware<ShopEnv>(async (c, next) => {
  if (Deno.env.get("SKIP_AUTH") === "true") {
    const devShop = Deno.env.get("DEV_SHOP_ID");
    if (!devShop) {
      return c.json({ error: { code: "NO_SHOP", message: "DEV_SHOP_ID not set" } }, 500);
    }
    c.set("shopId", devShop);
    c.set("isOwner", false);
    await next();
    return;
  }

  const user = c.get("authUser");
  const role = user.role;

  let homeShopId: string | null = null;
  if (role === "mechanic") {
    const [p] = await db.select({ shopId: schema.providers.shopId })
      .from(schema.providers).where(eq(schema.providers.authUserId, user.id)).limit(1);
    homeShopId = p?.shopId ?? null;
  } else if (role === "admin") {
    const [cust] = await db.select({ shopId: schema.customers.shopId })
      .from(schema.customers).where(eq(schema.customers.authUserId, user.id)).limit(1);
    homeShopId = cust?.shopId ?? null;
  }

  const headerShopId = c.req.header("X-Shop-Id") ?? null;
  const validShopIds = role === "owner" ? await loadValidShopIds() : [];

  const picked = pickShopId({ role, homeShopId, headerShopId, validShopIds });
  if ("error" in picked) {
    const message = picked.error === "NO_SHOP"
      ? "No shop assigned to this account"
      : "Unknown shop";
    return c.json({ error: { code: picked.error, message } }, 403);
  }
  c.set("shopId", picked.shopId);
  c.set("isOwner", picked.isOwner);
  await next();
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/gateway && deno check src/middleware/shop-context.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/middleware/shop-context.ts
git commit -m "feat(gateway): requireShopContext middleware"
```

### Task 6: Fix `requireAuth` to match by auth_user_id

**Files:**
- Modify: `apps/gateway/src/middleware/auth.ts`

- [ ] **Step 1: Replace the email lookup**

In `apps/gateway/src/middleware/auth.ts`, replace the customer lookup inside `requireAuth`:
```typescript
  const [customer] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.email, user.email))
    .limit(1);
```
with an auth_user_id-first lookup that falls back to email (transition-safe):
```typescript
  let [customer] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.authUserId, user.id))
    .limit(1);
  if (!customer && user.email) {
    [customer] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.email, user.email))
      .limit(1);
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/gateway && deno check src/middleware/auth.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/middleware/auth.ts
git commit -m "fix(gateway): requireAuth matches customer by auth_user_id (email fallback)"
```

---

## Phase 2 — Scoping layer + apply to routes

### Task 7: `tenant.ts` scoped reads + L2 isolation test

**Files:**
- Create: `apps/agent/src/db/tenant.ts`
- Modify: `apps/agent/src/db/client.ts` (re-export)
- Test: `apps/agent/src/db/tenant_db_test.ts`

- [ ] **Step 1: Write `tenant.ts`**

`apps/agent/src/db/tenant.ts`:
```typescript
import { and, eq, type SQL } from "drizzle-orm";
import { db, schema } from "./client.ts";

/** Mirror of the gateway sentinel (owner, no shop selected). */
export const OWNER_ALL_SHOPS = "__all__";

/**
 * shop predicate for a tenant table column. Returns undefined for the
 * owner all-shops sentinel (caller must only reach this from read-only paths).
 */
export function whereShop(
  // deno-lint-ignore no-explicit-any
  column: any,
  shopId: string,
): SQL | undefined {
  return shopId === OWNER_ALL_SHOPS ? undefined : eq(column, shopId);
}

/** Combine a shop scope with extra conditions. */
export function scoped(
  // deno-lint-ignore no-explicit-any
  column: any,
  shopId: string,
  ...extra: (SQL | undefined)[]
): SQL | undefined {
  return and(whereShop(column, shopId), ...extra);
}

/** List orders for a shop (status optional). */
export function ordersForShop(shopId: string, status?: string) {
  return db.select().from(schema.orders).where(
    status
      ? scoped(schema.orders.shopId, shopId, eq(schema.orders.status, status))
      : whereShop(schema.orders.shopId, shopId),
  );
}
```

- [ ] **Step 2: Re-export from the db entry**

In `apps/agent/src/db/client.ts`, add at the end:
```typescript
export * from "./tenant.ts";
```

- [ ] **Step 3: Write the L2 isolation test**

`apps/agent/src/db/tenant_db_test.ts`:
```typescript
// L2 — hits real Postgres. Skips if no DATABASE_URL.
import { assertEquals } from "@std/assert";
import { db, ordersForShop, schema } from "./client.ts";
import { eq } from "drizzle-orm";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const MARK = "[tenant-l2]";

Deno.test({
  name: "ordersForShop returns only the scoped shop's orders",
  ignore: !DATABASE_URL,
  fn: async () => {
    // Two shops
    const [a] = await db.insert(schema.shops).values({ name: `${MARK} A`, slug: `${MARK}-a-${crypto.randomUUID()}` }).returning();
    const [b] = await db.insert(schema.shops).values({ name: `${MARK} B`, slug: `${MARK}-b-${crypto.randomUUID()}` }).returning();
    // One customer + one order per shop
    const [ca] = await db.insert(schema.customers).values({ name: `${MARK} ca`, shopId: a.id }).returning();
    const [cb] = await db.insert(schema.customers).values({ name: `${MARK} cb`, shopId: b.id }).returning();
    const [oa] = await db.insert(schema.orders).values({ shopId: a.id, customerId: ca.id }).returning();
    const [ob] = await db.insert(schema.orders).values({ shopId: b.id, customerId: cb.id }).returning();

    const aOrders = await ordersForShop(a.id);
    assertEquals(aOrders.some((o) => o.id === oa.id), true);
    assertEquals(aOrders.some((o) => o.id === ob.id), false);

    // Cleanup
    await db.delete(schema.orders).where(eq(schema.orders.id, oa.id));
    await db.delete(schema.orders).where(eq(schema.orders.id, ob.id));
    await db.delete(schema.customers).where(eq(schema.customers.id, ca.id));
    await db.delete(schema.customers).where(eq(schema.customers.id, cb.id));
    await db.delete(schema.shops).where(eq(schema.shops.id, a.id));
    await db.delete(schema.shops).where(eq(schema.shops.id, b.id));
  },
});
```

- [ ] **Step 4: Run the L2 test**

Run: `infisical run --env=dev -- deno test -A apps/agent/src/db/tenant_db_test.ts`
Expected: PASS (1 test). If no DATABASE_URL, it is skipped — re-run under infisical.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/db/tenant.ts apps/agent/src/db/client.ts apps/agent/src/db/tenant_db_test.ts
git commit -m "feat(db): tenant scoping helpers + L2 isolation test"
```

### Task 8: Apply shop scope to gateway routes

Mount `requireShopContext` and add `eq(schema.<table>.shopId, c.get("shopId"))` to every orders/customers/providers query. Read `const shopId = c.get("shopId");` at the top of each handler. The owner all-shops sentinel (`OWNER_ALL_SHOPS`) only reaches read endpoints; writes must reject it (Step 7).

**Files:**
- Modify: `apps/gateway/src/hmls-app.ts`, `routes/orders.ts`, `routes/admin.ts`, `routes/portal.ts`, `routes/admin-mechanics.ts`, `routes/mechanic.ts`, `routes/estimates.ts`

- [ ] **Step 1: Mount `requireShopContext` after the auth middleware on each router**

In each router file, add the import and the `.use`. Example for `orders.ts` (currently `orders.use("*", requireAdmin);`):
```typescript
import { requireShopContext, type ShopEnv } from "../middleware/shop-context.ts";
// change the generic + add the second middleware:
const orders = new Hono<ShopEnv>();
orders.use("*", requireAdmin);
orders.use("*", requireShopContext);
```
Apply the same pattern to `admin.ts`, `admin-mechanics.ts` (after `requireAdmin`), `portal.ts` (after `requireAuth`), `mechanic.ts` (after `requireMechanic`), `estimates.ts` (whatever auth it uses — if public/unauth, scope by the order's own shopId, no context needed; see Step 6).

- [ ] **Step 2: Scope `orders.ts`**

- List handler: prepend the shop condition to the `conditions` array:
```typescript
const shopId = c.get("shopId");
const conditions = [eq(schema.orders.shopId, shopId)];
// ...existing status/search pushes unchanged...
```
- Single-order GET (`.where(eq(schema.orders.id, id))`): change to
```typescript
.where(and(eq(schema.orders.id, id), eq(schema.orders.shopId, shopId)))
```
- POST create (`.insert(schema.orders).values({...})`): add `shopId,` to the values object (reject the sentinel first — Step 7).

- [ ] **Step 3: Scope `admin.ts`**

- Customer list: base `.where(eq(schema.customers.shopId, shopId))` before `.$dynamic()`.
- Customer GET single + its orders: add `eq(schema.customers.shopId, shopId)` / `eq(schema.orders.shopId, shopId)` via `and(...)`.
- Dashboard counts: add `eq(schema.orders.shopId, shopId)` to each count's `where`.
- Customer create/update: stamp/guard `shopId`.

- [ ] **Step 4: Scope `portal.ts`**

Customer routes already filter by `customerId` (from `requireAuth`). Add `eq(schema.orders.shopId, shopId)` as a belt-and-suspenders condition on the `/me/orders` list and the single-order ownership query.

- [ ] **Step 5: Scope `admin-mechanics.ts` + `mechanic.ts`**

- `admin-mechanics.ts` provider list: `.where(eq(schema.providers.shopId, shopId))`. Provider create: stamp `shopId`. Provider update/delete: `and(eq(id), eq(shopId))`. Week-bookings order query: add `eq(schema.orders.shopId, shopId)`.
- `mechanic.ts` orders list: add `eq(schema.orders.shopId, shopId)` to the conditions array.

- [ ] **Step 6: Scope `estimates.ts`**

The public PDF/estimate route reads an order by `id`/`shareToken` with no auth. Do NOT add a shop filter (the shareToken already authorizes that specific order). Leave as-is; note in a code comment that shareToken is the scope here.

- [ ] **Step 7: Block writes under the owner all-shops sentinel**

In each write handler (order create, customer create/update, provider create/update), after reading `shopId`, add:
```typescript
import { OWNER_ALL_SHOPS } from "../middleware/shop-context.ts";
if (shopId === OWNER_ALL_SHOPS) {
  return c.json({ error: { code: "NO_SHOP", message: "Select a shop before writing" } }, 400);
}
```

- [ ] **Step 8: Typecheck the gateway**

Run: `deno task check`
Expected: PASS. Fix any `c.get("shopId")` type errors by ensuring the router uses `Hono<ShopEnv>`.

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): scope orders/customers/providers reads+writes by shopId"
```

### Task 9: Unscoped-query guard test

**Files:**
- Test: `apps/gateway/src/tenant-guard_test.ts`

- [ ] **Step 1: Write the guard test**

`apps/gateway/src/tenant-guard_test.ts`:
```typescript
// Fails if a gateway route queries a tenant table without a shopId filter.
// Heuristic: any handler file that references schema.orders/customers/providers
// must also reference `shopId` (the scope). estimates.ts is the documented
// exception (shareToken is the scope).
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

const EXCEPT = new Set(["estimates.ts"]);
const TENANT = /schema\.(orders|customers|providers)\b/;

Deno.test("every gateway route that touches a tenant table scopes by shopId", async () => {
  const offenders: string[] = [];
  for await (const entry of walk(new URL("./routes", import.meta.url).pathname, { exts: [".ts"] })) {
    if (entry.name.endsWith("_test.ts") || EXCEPT.has(entry.name)) continue;
    const src = await Deno.readTextFile(entry.path);
    if (TENANT.test(src) && !src.includes("shopId")) offenders.push(entry.name);
  }
  assertEquals(offenders, []);
});
```

- [ ] **Step 2: Run it; expect pass (routes already scoped)**

Run: `cd apps/gateway && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/tenant-guard_test.ts`
Expected: PASS. If a file is listed, it has an unscoped query — fix it.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/tenant-guard_test.ts
git commit -m "test(gateway): guard against unscoped tenant queries"
```

---

## Phase 3 — Order → shop routing + per-shop pricing (agent)

### Task 10: `nearestShop` + geocode parser (pure) + tests

**Files:**
- Create: `apps/agent/src/common/shop-routing.ts`
- Test: `apps/agent/src/common/shop-routing_test.ts`

- [ ] **Step 1: Write the failing test**

`apps/agent/src/common/shop-routing_test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { nearestShop, parseGeocodeResponse } from "./shop-routing.ts";

const SJ = { id: "sj", latitude: "37.3361663", longitude: "-121.890591", serviceRadiusKm: null };
const OC = { id: "oc", latitude: "33.6484505", longitude: "-117.8365716", serviceRadiusKm: null };

Deno.test("nearestShop: a Bay Area point picks San Jose", () => {
  // Sunnyvale
  assertEquals(nearestShop({ lat: 37.3688, lng: -122.0363 }, [SJ, OC]), "sj");
});

Deno.test("nearestShop: a SoCal point picks Orange County", () => {
  // Santa Ana
  assertEquals(nearestShop({ lat: 33.7455, lng: -117.8677 }, [SJ, OC]), "oc");
});

Deno.test("nearestShop: outside every radius => null", () => {
  const capped = [{ ...SJ, serviceRadiusKm: 50 }, { ...OC, serviceRadiusKm: 50 }];
  assertEquals(nearestShop({ lat: 40.0, lng: -100.0 }, capped), null);
});

Deno.test("parseGeocodeResponse: extracts lat/lng from a Google OK payload", () => {
  const body = { status: "OK", results: [{ geometry: { location: { lat: 37.1, lng: -121.2 } } }] };
  assertEquals(parseGeocodeResponse(body), { lat: 37.1, lng: -121.2 });
});

Deno.test("parseGeocodeResponse: ZERO_RESULTS => null", () => {
  assertEquals(parseGeocodeResponse({ status: "ZERO_RESULTS", results: [] }), null);
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `cd apps/agent && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/common/shop-routing_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure pieces**

`apps/agent/src/common/shop-routing.ts`:
```typescript
export interface ShopGeo {
  id: string;
  latitude: string | null;
  longitude: string | null;
  serviceRadiusKm: number | null;
}
export interface Coords {
  lat: number;
  lng: number;
}

/** Equirectangular distance in km — fine for picking among shops. */
function km(a: Coords, b: Coords): number {
  const dLat = a.lat - b.lat;
  const dLng = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111.32;
}

/** Nearest shop to a point; null if every shop with a radius is out of range. */
export function nearestShop(point: Coords, shops: ShopGeo[]): string | null {
  let best: { id: string; d: number } | null = null;
  for (const s of shops) {
    if (s.latitude == null || s.longitude == null) continue;
    const d = km(point, { lat: Number(s.latitude), lng: Number(s.longitude) });
    if (s.serviceRadiusKm != null && d > s.serviceRadiusKm) continue;
    if (!best || d < best.d) best = { id: s.id, d };
  }
  return best?.id ?? null;
}

/** Extract coords from a Google Geocoding API response, or null. */
// deno-lint-ignore no-explicit-any
export function parseGeocodeResponse(body: any): Coords | null {
  const loc = body?.results?.[0]?.geometry?.location;
  if (body?.status !== "OK" || !loc) return null;
  return { lat: loc.lat, lng: loc.lng };
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `cd apps/agent && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/common/shop-routing_test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/common/shop-routing.ts apps/agent/src/common/shop-routing_test.ts
git commit -m "feat(agent): nearestShop + geocode response parser (pure)"
```

### Task 11: `geocodeAddress` + `routeOrderToShop` (best-effort I/O)

**Files:**
- Modify: `apps/agent/src/common/shop-routing.ts`

- [ ] **Step 1: Append the I/O functions**

Add to `apps/agent/src/common/shop-routing.ts`:
```typescript
import { db, schema } from "../db/client.ts";

const GEOCODE_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";

/** Best-effort geocode. Returns null on any failure — never throws. */
export async function geocodeAddress(address: string): Promise<Coords | null> {
  if (!GEOCODE_KEY || !address.trim()) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${
      encodeURIComponent(address)
    }&key=${GEOCODE_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseGeocodeResponse(await res.json());
  } catch {
    return null;
  }
}

/**
 * Resolve which shop an order belongs to from its service address.
 * Best-effort: geocode failure or no match falls back to the primary shop
 * (san-jose) with autoRouted=false so staff can review.
 */
export async function routeOrderToShop(
  address: string | null,
): Promise<{ shopId: string; coords: Coords | null; autoRouted: boolean }> {
  const shops = await db.select({
    id: schema.shops.id,
    slug: schema.shops.slug,
    latitude: schema.shops.latitude,
    longitude: schema.shops.longitude,
    serviceRadiusKm: schema.shops.serviceRadiusKm,
  }).from(schema.shops);

  const primary = shops.find((s) => s.slug === "san-jose") ?? shops[0];
  const coords = address ? await geocodeAddress(address) : null;
  const matchedId = coords ? nearestShop(coords, shops) : null;
  if (matchedId) return { shopId: matchedId, coords, autoRouted: true };
  return { shopId: primary.id, coords, autoRouted: false };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/agent && deno check src/common/shop-routing.ts`
Expected: PASS.

- [ ] **Step 3: Add the env var to Infisical (dev=prod)**

Provision `GOOGLE_MAPS_API_KEY` (confirm the existing `GOOGLE_API_KEY` project has the Geocoding API enabled, or add a separate key). Add via Infisical UI/CLI. (No code change — the fallback to `GOOGLE_API_KEY` keeps it running if reused.)

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/common/shop-routing.ts
git commit -m "feat(agent): best-effort geocode + routeOrderToShop"
```

### Task 12: Stamp `shopId` in create_order + per-shop labor rate

**Files:**
- Modify: `apps/agent/src/hmls/skills/estimate/pricing.ts`
- Modify: `apps/agent/src/common/tools/order.ts`

- [ ] **Step 1: Make pricing shop-aware**

In `apps/agent/src/hmls/skills/estimate/pricing.ts`, change `getPricingConfig` to accept an optional shop rate override. Add a helper and thread it:
```typescript
/** Fetch a shop's labor rate (cents), or null to use the global default. */
export async function shopHourlyRate(shopId: string): Promise<number | null> {
  const [s] = await db.select({ rate: schema.shops.laborRateCents })
    .from(schema.shops).where(eq(schema.shops.id, shopId)).limit(1);
  return s?.rate ?? null;
}
```
Add `import { eq } from "drizzle-orm";` if not present. In `calculatePrice` and the `priceServices` reducer, accept an optional `hourlyRateOverride` and use it: change the labor line from `config.hourlyRate` to `(hourlyRateOverride ?? config.hourlyRate)`. Update the `ServiceInput`/signatures to pass it through.

- [ ] **Step 2: Route + stamp in create_order**

In `apps/agent/src/common/tools/order.ts`:
- imports: `import { routeOrderToShop } from "../shop-routing.ts";` and `import { shopHourlyRate } from "../../hmls/skills/estimate/pricing.ts";`

**Why the sequence matters:** `customers.shopId` is now `NOT NULL`, so a guest-customer INSERT must already carry a shopId. For a brand-new walk-in the only address available pre-insert is `customerInfo.address`; existing customers already carry a shopId (post-backfill). So route first from the provided address, stamp the guest with it, then route the order from the final address.

Deterministic sequence (INSERT branch):
```typescript
// 1. address available before customer resolution (walk-in case)
const addressIn = clean(params.customerInfo?.address) ?? null;
// 2. route from it so a NEW guest customer gets a NOT-NULL shopId
const guestRoute = await routeOrderToShop(addressIn);
// 3. resolveCustomer stamps the guest INSERT with this shopId (new param)
const customer = await resolveCustomer(ctx.customerId, params.customerId, params.customerInfo, guestRoute.shopId);
// 4. final service address may fall back to the customer profile
const orderAddress = addressIn ?? customer.address ?? null;
// 5. route the ORDER (reuse guestRoute when the address came from input)
const routed = addressIn ? guestRoute : await routeOrderToShop(orderAddress);
const shopRate = await shopHourlyRate(routed.shopId);
```
- Pass `shopRate` into the pricing calls (e.g. `priceServices(services, shopRate)`, threading an optional `hourlyRateOverride` from Task 12 Step 1).
- In the order `.insert(schema.orders).values({...})` object, add:
```typescript
      shopId: routed.shopId,
      locationLat: routed.coords ? String(routed.coords.lat) : null,
      locationLng: routed.coords ? String(routed.coords.lng) : null,
```
- Change `resolveCustomer`'s signature to accept a trailing `defaultShopId: string`, and in its guest INSERT (`.insert(schema.customers).values({...})`) add `shopId: defaultShopId`. Existing-customer branches ignore it.
- UPDATE-in-place branch (existing orderId): do NOT re-route — keep the existing `shopId` (manual override wins). Only compute routing when inserting a new order.

- [ ] **Step 3: Typecheck**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 4: L2 test — order gets routed shop + customer inherits it**

`apps/agent/src/common/tools/order_routing_db_test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { routeOrderToShop } from "../shop-routing.ts";

Deno.test({
  name: "routeOrderToShop falls back to primary when address is null",
  ignore: !Deno.env.get("DATABASE_URL"),
  fn: async () => {
    const r = await routeOrderToShop(null);
    assertEquals(r.autoRouted, false);
    assertEquals(typeof r.shopId, "string");
  },
});
```
Run: `infisical run --env=dev -- deno test -A apps/agent/src/common/tools/order_routing_db_test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/common/tools/order.ts apps/agent/src/hmls/skills/estimate/pricing.ts apps/agent/src/common/tools/order_routing_db_test.ts
git commit -m "feat(agent): route+stamp shopId on create_order, per-shop labor rate"
```

### Task 13: Pass shopId from chat routes to the agent

**Files:**
- Modify: `apps/gateway/src/routes/chat.ts`, `apps/gateway/src/routes/staff-chat.ts`

- [ ] **Step 1: Mount shop context + thread shopId**

Both chat routes already resolve auth. Add `requireShopContext` to their middleware chain, read `const shopId = c.get("shopId");`, and pass it into the agent run options so `create_order`'s context can prefer it (customer chat: the customer's shop; staff chat: the admin/owner's selected shop). For customer chat, the routed shop from the address still wins for the order; the ctx shopId is the customer's home shop used when stamping a brand-new customer row. Wire `shopId` into the existing agent context object alongside `customerId`.

- [ ] **Step 2: Typecheck**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/routes/chat.ts apps/gateway/src/routes/staff-chat.ts
git commit -m "feat(gateway): thread shopId from chat routes into the agent"
```

---

## Phase 4 — Admin UI owner switcher

### Task 14: Active-shop helpers (pure) + tests

**Files:**
- Create: `apps/hmls-web/lib/active-shop.ts`
- Test: `apps/hmls-web/lib/active-shop.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/hmls-web/lib/active-shop.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { ACTIVE_SHOP_KEY, readActiveShop, writeActiveShop } from "./active-shop";

describe("active shop persistence", () => {
  test("round-trips a shop id through a storage stub", () => {
    const store: Record<string, string> = {};
    const stub = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    } as Storage;
    expect(readActiveShop(stub)).toBeNull();
    writeActiveShop(stub, "abc");
    expect(store[ACTIVE_SHOP_KEY]).toBe("abc");
    expect(readActiveShop(stub)).toBe("abc");
  });

  test("readActiveShop tolerates a missing storage (SSR)", () => {
    expect(readActiveShop(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `cd apps/hmls-web && bun test lib/active-shop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/hmls-web/lib/active-shop.ts`:
```typescript
export const ACTIVE_SHOP_KEY = "hmls-admin-active-shop";

export function readActiveShop(storage: Storage | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(ACTIVE_SHOP_KEY);
  } catch {
    return null;
  }
}

export function writeActiveShop(storage: Storage | undefined, shopId: string): void {
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_SHOP_KEY, shopId);
  } catch {
    /* storage unavailable */
  }
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `cd apps/hmls-web && bun test lib/active-shop.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hmls-web/lib/active-shop.ts apps/hmls-web/lib/active-shop.test.ts
git commit -m "feat(web): active-shop localStorage helpers"
```

### Task 15: Wire `isOwner` + `X-Shop-Id` header through the client

**Files:**
- Modify: `apps/hmls-web/lib/api-client.ts`
- Modify: `apps/hmls-web/components/AuthProvider.tsx`
- Create: `apps/hmls-web/hooks/useActiveShop.ts`

- [ ] **Step 1: Add the header param to the api client**

In `apps/hmls-web/lib/api-client.ts`, change `createApiClient(token)` to `createApiClient(token, shopId?)` and in `buildInit` add:
```typescript
    if (shopId) headers["X-Shop-Id"] = shopId;
```

- [ ] **Step 2: Expose `isOwner` and an active-shop-aware client in AuthProvider**

In `apps/hmls-web/components/AuthProvider.tsx`:
- In `rolesFromSession`, add `isOwner: role === "owner"` and include `isOwner` in the returned object and `AuthContextType`.
- Add `useActiveShop` state and pass the active shop id into `createApiClient(session?.access_token, activeShopId)` (only meaningful for owners; harmless otherwise). Recreate the client when `activeShopId` changes.

`apps/hmls-web/hooks/useActiveShop.ts`:
```typescript
"use client";
import { useEffect, useState } from "react";
import { readActiveShop, writeActiveShop } from "@/lib/active-shop";

export function useActiveShop(): [string | null, (id: string) => void] {
  const [shopId, setShopId] = useState<string | null>(null);
  useEffect(() => {
    setShopId(readActiveShop(typeof window === "undefined" ? undefined : window.localStorage));
  }, []);
  const set = (id: string) => {
    writeActiveShop(typeof window === "undefined" ? undefined : window.localStorage, id);
    setShopId(id);
  };
  return [shopId, set];
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/hmls-web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/hmls-web/lib/api-client.ts apps/hmls-web/components/AuthProvider.tsx apps/hmls-web/hooks/useActiveShop.ts
git commit -m "feat(web): owner role + X-Shop-Id header threading"
```

### Task 16: Shops-list endpoint + `<ShopSwitcher>`

**Files:**
- Modify: `apps/gateway/src/routes/admin.ts` (add `GET /shops`)
- Create: `apps/hmls-web/components/admin/ShopSwitcher.tsx`
- Modify: `apps/hmls-web/components/Navbar.tsx`

- [ ] **Step 1: Add a shops-list endpoint (owner only)**

In `apps/gateway/src/routes/admin.ts`, add a handler that returns all shops (id, name, slug). It must NOT be shop-scoped (the owner needs the full list). Gate it: only return the full list when `c.get("isOwner")`; otherwise return just the caller's own shop.
```typescript
admin.get("/shops", async (c) => {
  const isOwner = c.get("isOwner");
  const shopId = c.get("shopId");
  const rows = isOwner
    ? await db.select({ id: schema.shops.id, name: schema.shops.name, slug: schema.shops.slug }).from(schema.shops)
    : await db.select({ id: schema.shops.id, name: schema.shops.name, slug: schema.shops.slug }).from(schema.shops).where(eq(schema.shops.id, shopId));
  return c.json(rows);
});
```
(This route reads `schema.shops`, not a tenant table, so the guard test in Task 9 does not flag it — but add `shops` is not in the guard's `TENANT` regex anyway.)

- [ ] **Step 2: Build the switcher (owner only)**

`apps/hmls-web/components/admin/ShopSwitcher.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useActiveShop } from "@/hooks/useActiveShop";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Shop = { id: string; name: string; slug: string };

export function ShopSwitcher() {
  const { isOwner, api } = useAuth();
  const [shops, setShops] = useState<Shop[]>([]);
  const [activeShop, setActiveShop] = useActiveShop();

  useEffect(() => {
    if (!isOwner) return;
    api.get<Shop[]>("/api/admin/shops").then(setShops).catch(() => setShops([]));
  }, [isOwner, api]);

  if (!isOwner || shops.length === 0) return null;

  return (
    <Select value={activeShop ?? ""} onValueChange={setActiveShop}>
      <SelectTrigger className="w-44 h-8 text-xs">
        <SelectValue placeholder="All shops" />
      </SelectTrigger>
      <SelectContent>
        {shops.map((s) => (
          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 3: Mount it in the Navbar**

In `apps/hmls-web/components/Navbar.tsx`, import `ShopSwitcher` and render `<ShopSwitcher />` in the nav controls area (near the theme/logout controls). It self-hides for non-owners.

- [ ] **Step 4: Typecheck + lint**

Run: `cd apps/hmls-web && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/admin.ts apps/hmls-web/components/admin/ShopSwitcher.tsx apps/hmls-web/components/Navbar.tsx
git commit -m "feat: owner shop switcher + shops-list endpoint"
```

---

## Phase 5 — Full verification

### Task 17: CI gate + manual smoke

- [ ] **Step 1: Run the full CI suite**

```bash
cd apps/hmls-web && bun run lint
cd apps/hmls-web && bun run typecheck
cd apps/hmls-web && bun run test
cd apps/hmls-web && infisical run --env=dev -- bun run build
deno task check
cd apps/gateway && deno test --allow-env --allow-read --allow-net --allow-sys --allow-ffi src/
infisical run --env=dev -- deno test -A apps/agent/src/db/tenant_db_test.ts
```
Expected: all PASS.

- [ ] **Step 2: Manual smoke (local stack)**

Start the stack (`deno task dev:api` + web with `GATEWAY_URL`), sign in as an admin, confirm `/admin/orders` shows only San Jose orders. Promote your account to `owner` (set `customers.role='owner'` for your auth_user_id), reload, confirm the switcher appears and switching changes the order list. Create an order via `/admin/chat` with a Santa Ana address → confirm it routes to `orange-county`.

- [ ] **Step 3: Update project memory**

Update `project_multi_tenancy.md` status to "implemented + verified" with the migration numbers (0027/0028) and the shop slugs.

---

## Self-Review Notes (author checklist — completed)

- **Spec coverage:** data model (Task 1–3), shop-context incl. owner/staff-split + requireAuth fix (Task 4–6), scoping layer + guard (Task 7–9), routing + geocoding + per-shop rate (Task 10–13), owner switcher (Task 14–16), no-tax honored (Task 3 seeds tax 0), prod-caution gate (Task 3 Step 3). RLS / subdomains / billing explicitly out of scope per spec.
- **Naming consistency:** drizzle fields `schema.{orders,customers,providers}.shopId` (camelCase) throughout; `OWNER_ALL_SHOPS` sentinel defined in both `shop-context.ts` and `tenant.ts`; `pickShopId` / `nearestShop` / `routeOrderToShop` / `geocodeAddress` / `shopHourlyRate` referenced consistently.
- **Open dependency:** `GOOGLE_MAPS_API_KEY` provisioning (Task 11 Step 3) — code falls back to `GOOGLE_API_KEY` so it never hard-fails.
