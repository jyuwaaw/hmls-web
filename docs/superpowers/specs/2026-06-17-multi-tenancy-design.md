# Multi-tenancy enforcement (shop_id scoping)

**Date:** 2026-06-17
**Status:** Design — awaiting review
**Branch:** spinsirr/zen-curran-5a1a4b

## Context

The dogfood mobile-mechanic business now operates two locations (Orange County /
Irvine + San Jose), and more shops are coming — including, per the product
direction, real external SaaS-customer shops. The `shops` table exists, and
`customers.shop_id` / `orders.shop_id` columns exist, but **nothing writes or
reads them** — every query is unscoped, so both locations' orders, customers,
and mechanics are mixed in one admin view. We need to enforce tenant isolation.

### Locked decisions (from brainstorming)

1. **Tenant model:** hard isolation as the design target, with an `owner`
   role that can see across shops. Today the shops are one operator's two
   locations; the model must not need a rewrite when external tenants arrive.
2. **Shop-context resolution:** each staff member belongs to one home shop
   (stored on their record); `owner` switches shops via a UI switcher. Single
   domain (`hmls.autos`), no subdomains.
3. **Enforcement mechanism:** application-level scoping at the gateway now;
   Postgres RLS deferred to a later phase as a DB-level backstop, to land
   before the first paying external tenant's data shares the database.
4. **Order → shop routing:** route each order to the nearest shop by the
   service address, generically over `shops.lat/lng` (not hardcoded to the two
   current metros). Resolve the address to coordinates with a real geocoding
   call (best-effort, non-blocking).

## Goals

- An admin/mechanic sees and acts on **only their shop's** orders, customers,
  and mechanics.
- An `owner` sees all shops; can scope to one shop via a switcher; aggregate
  (read-only) views may span all shops.
- New orders are routed to the correct shop by service location.
- The data model and routing are **general over N shops** from day one.
- Per-shop labor rate and tax rate flow into pricing.
- Existing data is backfilled and the scoping columns become `NOT NULL`.

## Non-goals (this phase)

- Postgres RLS (Phase 2 — DB-level backstop).
- Subdomains / per-shop customer entry points.
- Per-shop Stripe / billing isolation (Stripe stays dormant).
- Self-serve shop onboarding UI (shops are created by hand for now).
- Per-shop branding.
- Per-shop tax or fee constants (hazmat/tire/battery/travel/etc.). Only the
  labor rate goes per-shop now; the engine applies no tax today.

## Current state (verified)

- **`shops`** (`packages/shared/src/db/schema.ts`): `id uuid`, `name`, `slug`
  (unique), `timezone`, `labor_rate_cents` (default 12000), `tax_rate_percent`
  (default 0.1000), `stripe_account_id`, `created_at`. Per-shop labor/tax/tz
  already modeled.
- **`customers`**: has `shop_id uuid → shops.id` (**nullable, never
  written/read**); also `auth_user_id` (unique), `role`
  (`customer|admin|mechanic`), `email` (NOT unique). Staff are customer rows
  with a non-customer role.
- **`orders`**: has `shop_id uuid → shops.id` (**nullable, never
  written/read**); `customer_id NOT NULL`, `provider_id`, `location`,
  `location_lat/lng` (numeric, **not populated by the create_order path**),
  `contact_address` (the service address — **required** for customer-chat
  orders).
- **`providers`** (mechanics): **no `shop_id`**.
- **`pricing_config`**: global key-value (not per shop).
- **Auth:** Supabase JWT. `custom_access_token_hook` injects a `user_role`
  claim from `customers.role`. `requireAuth` looks up the customer **by email**
  (a latent multi-tenant hazard) and sets `customerId`. `requireAdmin` trusts
  the JWT role with no DB query. **Nothing resolves "current shop" per
  request.** No staff→shop mapping beyond the unused `customers.shop_id`.
- **DB access:** single shared `postgres()` service-role connection pool over
  the Supabase pooler (`createDbClient`). RLS is **not enabled** on any app
  table.
- **Web → DB:** the web app uses Supabase **only for auth** (`auth.getUser()`);
  it never queries app tables directly. All order/customer data flows through
  the gateway. → Gateway-level app scoping is a sufficient boundary now; RLS is
  pure defense-in-depth.
- **Existing geo:** `apps/hmls-web/lib/business.ts` defines `REGIONS = { oc, sj }`
  with coordinates; `apps/hmls-web/lib/map-cities.ts` has a tested
  `nearestRegion(lat,lng)` (haversine, 400km cap). Useful as a reference for
  `nearestShop`, but routing will read coordinates from the `shops` table, not
  from this web-only constant.

Scoping surface area: ~10 gateway files + ~12 agent files query
orders/customers/providers.

**Verified prod snapshot (2026-06-17):** `shops` is **empty** (0 rows). 81
orders, 99 customers, 5 providers — **all** with NULL `shop_id`. Roles in
`customers`: 96 customer + 3 admin, **0 mechanic** (mechanics exist only as
`providers` rows). 38/99 customers have `auth_user_id` (61 NULL — mostly
staff-created guests). Global `hourly_rate` = 14000 ($140/hr); **no tax key**
in `pricing_config` (the engine applies no tax today).

## Design

### 1. Data model (`packages/shared/src/db/schema.ts`)

- `userRoleEnum`: add **`owner`** → `customer | admin | mechanic | owner`.
- `shops`: add `latitude numeric(10,7)`, `longitude numeric(10,7)`,
  `serviceRadiusKm integer` (all nullable; `serviceRadiusKm` null = no cap).
- `providers`: add `shopId uuid → shops.id` (nullable → backfill → NOT NULL).
- `customers.shopId`, `orders.shopId`: keep, then backfill → NOT NULL.
- Indexes for scoped reads: `customers_shop_id_idx`, `providers_shop_id_idx`,
  and a composite `orders_shop_status_idx (shop_id, status)` (the admin list is
  filtered by shop then status).

No `memberships` table (YAGNI — one home shop per staff; `owner` crosses shops
by role). Revisit if a staff member must belong to multiple shops.

### 2. Auth / shop-context (`apps/gateway/src/middleware/`)

New `shopContext.ts` exposing `requireShopContext`, mounted after
`requireAdmin` / `requireAuth`. It sets `c.var.shopId` (and `c.var.isOwner`):

- **admin / mechanic** → resolve the home shop by `auth_user_id` (one indexed
  read). Staff identity is **split**: admins are `customers` rows (role=admin)
  → `customers.shop_id`; mechanics are `providers` rows (no mechanic-role
  customer rows exist) → `providers.shop_id`. Check `providers` first, then
  `customers`. Any `X-Shop-Id` header is ignored for non-owners.
- **owner** → read `X-Shop-Id` header (the switcher's selected shop), validate
  it exists in `shops`. **No header = "all shops"**: allowed for read-only
  aggregate endpoints; any write returns `400 "select a shop"`.
- **customer** (`requireAuth`) → `c.var.shopId = customers.shop_id`.

Also in this phase:

- **Fix `requireAuth`**: match the customer by `auth_user_id` (the JWT `sub`),
  not by `email`. Email is non-unique and mutable; matching on it across
  tenants can cross-link accounts. Transition: prefer `auth_user_id`, fall back
  to `email` only if `auth_user_id` is null, and backfill `auth_user_id` (see
  Open Items).
- Extend `AuthEnv` / `AdminEnv` variable types with `shopId: string` (+
  `isOwner: boolean`).
- Dev bypass (`SKIP_AUTH`): add `DEV_SHOP_ID` (defaults to the primary shop).

### 3. Query scoping layer

A single choke point so the filter cannot be forgotten.

- New `packages/shared/src/db/tenant.ts` (importable by gateway + agent):
  - `whereShop(table, shopId)` → the `eq(table.shopId, shopId)` predicate.
  - Thin scoped repo helpers for the hot reads: `listOrders`, `getOrder`,
    `searchCustomers`, `listProviders` — each takes `shopId` and applies the
    filter. Owner "all shops" reads pass a sentinel that skips the filter and
    is only reachable from read-only endpoints.
- **Writes stamp `shopId`**: `create_order` (order + customer upsert) and
  provider creation set `shop_id = ctx.shopId` (owner: the selected shop).
- **Guard test** (`apps/gateway` + `apps/agent`): a unit test that scans source
  for `.from(orders|customers|providers)` / `.from(schema.orders|...)` not
  reached through `tenant.ts`, and fails on a raw unscoped query. This converts
  "rely on discipline" into "rely on CI" — the known weak point of app-level
  scoping.

### 4. Order → shop routing

New `apps/agent/src/common/shop-routing.ts`:

- `geocodeAddress(address): Promise<{lat,lng} | null>` — Google Geocoding API,
  best-effort. Wrapped in try/catch; any failure returns `null` (mirrors the
  techPrep enrichment pattern — never blocks order creation).
- `nearestShop(coords, shops): shopId | null` — haversine over all
  `shops.lat/lng`; respects `serviceRadiusKm` when set; returns `null` if the
  point is outside every shop's radius. Generic over N shops.
- `routeOrderToShop(order, shops): { shopId, autoRouted: boolean }`:
  1. geocode `contact_address` → `nearestShop`.
  2. on geocode failure / no match → **primary shop**, `autoRouted: false`
     (flagged for staff review).
- `create_order` resolves `shopId` **before pricing** (pricing needs the shop's
  rate), stamps `order.shop_id`, and persists `location_lat/lng` from the
  geocode (bonus: enables drive-time / map later).
- **Manual override wins**: if `order.shop_id` is already set (staff/owner
  reassigned), later edits do **not** re-route. Auto-routing only runs when
  `shop_id` is unset.

An order's shop is determined by its **service address** (routing), independent
of the customer's home `customers.shop_id`. The same customer can have orders in
different shops — `customers.shop_id` is a first-touch default, not a wall
between the operator's own locations. (Hard per-tenant customer separation is a
Phase 2 concern for external tenants.)

### 5. Per-shop pricing

The estimate engine (`apps/agent/src/hmls/skills/estimate/`) reads
`labor_rate_cents` from the **order's shop** row instead of the global
`hourly_rate` (currently 14000 = $140/hr). All other fee constants — **and
tax** — stay as-is: there is **no tax key** in `pricing_config` today and the
engine applies none, so `shops.tax_rate_percent` stays dormant this phase
(wiring it would be a silent price change). Seed both shop rows with
`labor_rate_cents = 14000` so per-shop pricing is a **no-op** until a rate is
deliberately changed. Sequencing: `create_order` resolves `shopId` (routing) →
loads that shop's rate → prices.

### 6. Migration / backfill

> **Prod caution:** Infisical `--env=dev` connects to the production Supabase —
> there is no separate dev DB. Run via the standard `db:migrate` flow, backfill
> **before** `NOT NULL`, and review the SQL with the user before applying.

`0027_multi_tenancy` (enum change split out — `ALTER TYPE ... ADD VALUE` cannot
run in the same transaction as use of the new value, and some runners wrap
migrations in a txn):

1. `0027a`: `ALTER TYPE user_role ADD VALUE 'owner';` (standalone).
2. `0027b`:
   - `ALTER TABLE shops ADD COLUMN latitude/longitude/service_radius_km;`
   - `ALTER TABLE providers ADD COLUMN shop_id uuid REFERENCES shops(id);`
   - Create the two shop rows with coordinates (OC ≈ 33.6485,
     −117.8366; SJ ≈ 37.3362, −121.8906); slugs `san-jose` (primary) and
     `orange-county`, both `labor_rate_cents = 14000`, `timezone
     America/Los_Angeles`. (Verified 2026-06-17: `shops` is empty, so these are
     the first rows.)
   - Backfill **all** `customers` (99) / `orders` (81) / `providers` (5) → the
     **San Jose** shop id (the primary; every row currently has NULL
     `shop_id`). Some legacy orders may actually be OC jobs; staff reassign
     after backfill.
   - Backfill `customers.auth_user_id` where NULL (61 of 99) but the email
     matches an `auth.users` row, so the `requireAuth` switch finds real
     logins. Guests with no auth account keep NULL (they never hit
     `requireAuth`).
   - `ALTER ... SET NOT NULL` on `customers.shop_id`, `orders.shop_id`,
     `providers.shop_id`.
   - Create the indexes from §1.

### 7. Testing

- **Unit:** `nearestShop` (incl. radius cap + N>2 shops), `geocodeAddress`
  (mocked, incl. failure → null), `whereShop`.
- **Integration:** admin of shop A cannot read shop B's order (empty/403);
  owner with `X-Shop-Id` sees the selected shop; owner with no header gets the
  aggregate read but a blocked write; `create_order` stamps the routed shop;
  routing failure → primary shop + `autoRouted:false`.
- **Guard:** the unscoped-query scanner (§3).
- **Migration:** post-backfill assertion — zero NULL `shop_id`; `NOT NULL`
  holds.

### 8. Roadmap (Phase 2 — before the first paying external tenant)

- **RLS backstop:** enable RLS + policies on tenant tables; carry shop context
  into the DB session (dedicated non-BYPASSRLS role + request-scoped
  `SET LOCAL`, or a per-tenant connection). DB-level guarantee on top of app
  scoping.
- Customer→shop entry points (subdomain or per-shop link) for true external
  tenants.
- Stripe Connect per-shop billing isolation.
- Self-serve shop onboarding UI.
- Per-shop branding; per-shop fee constants.
- Cross-metro same-customer hardening (per-tenant customer rows; reconcile with
  `auth_user_id` uniqueness).

## Open items to confirm at implementation

1. ~~**Primary shop identity**~~ **RESOLVED** — primary = San Jose. `shops` is
   empty (verified), so the migration creates both rows: `san-jose` (primary,
   backfill target) + `orange-county`.
2. **Geocoding key** — provision a Google Geocoding API key (confirm whether
   the existing `GOOGLE_API_KEY` project has the Geocoding API enabled, or add a
   separate `GOOGLE_MAPS_API_KEY`).
3. ~~**`auth_user_id` coverage**~~ **RESOLVED** — 38/99 populated, 61 NULL
   (mostly staff-created guests who never hit `requireAuth`). Plan: backfill
   from `auth.users` by email where possible; switch `requireAuth` to
   `auth_user_id` with an email fallback during transition.

The only item now needing a key/provisioning action is #2 (geocoding API key).

## Risks

- **Forgotten scope filter** → cross-tenant leak. Mitigated by the choke-point
  repo + guard test + RLS backstop in Phase 2.
- **Geocoding dependency on the order hot path** → mitigated by best-effort
  (never blocks; falls back to primary shop + review flag).
- **Enum `ADD VALUE` migration** → split into its own statement/migration.
- **`requireAuth` email→auth_user_id switch** → could 403 customers whose
  `auth_user_id` is null; mitigated by the transition fallback + backfill.
