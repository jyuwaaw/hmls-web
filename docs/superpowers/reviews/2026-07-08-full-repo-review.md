# HMLS Full-Repo Review — Final Report

## Executive summary

The just-shipped RLS/tenancy layer is fundamentally sound: the core architecture (per-request GUC
via `withTenantScope`, fail-closed `tenant_app` role, `dbAdmin` reserved for bypass paths) is
well-designed, and the large majority of scoping mistakes found fail _closed_ (0 rows) rather than
leaking. The biggest real risks are not in the RLS policies themselves but around them: an unguarded
`SKIP_AUTH` backdoor and a silent `tenantDb()` fail-open fallback that both defeat the whole model
if an env var is misconfigured; a Fixo email-lookup that can bind a session to the wrong shop's
customer; and deactivated-mechanic access that survives soft-delete. Outside tenancy, there is a
genuine money bug (Stripe refund over-deduction) and a systemic correctness bug that silently breaks
auto-dispatch for essentially every customer-initiated booking. No findings rose to true "critical /
actively-exploited-in-prod-today"; the top items are high-impact-if-triggered with a misconfig or
specific-account precondition.

---

## HIGH

**Auth bypass backdoor — no env guard** `apps/gateway/src/middleware/admin.ts:22` (also
`auth.ts:30/132`, `mechanic.ts:27`, `shop-context.ts:58`)

- Defect: `SKIP_AUTH=true` short-circuits every auth middleware to a fixed dev identity with zero
  token check; nothing ties it to non-prod.
- Failure: the env var present in the prod Deno Deploy environment (shared/copied env group) → full
  unauthenticated admin/mechanic/customer access to all tenants.
- Fix: fail-fast at boot in `index.ts` — if `DENO_DEPLOYMENT_ID` is set (prod), assert `SKIP_AUTH`
  is unset/false.

**`tenantDb()` silently falls back to BYPASSRLS role** `packages/shared/src/db/client.ts:40`

- Defect: when `TENANT_DATABASE_URL` is unset, `tenantDb()` transparently uses the service_role
  `DATABASE_URL` (BYPASSRLS) with no warning.
- Failure: a deploy target missing/rotated `TENANT_DATABASE_URL` (new preview env, secret-sync gap)
  → every "fail-closed" `db` query loses its RLS backstop and returns cross-tenant rows, silently.
- Fix: hard-fail (or loud warn + refuse to serve) if `TENANT_DATABASE_URL` is absent; add a startup
  assertion that the tenant connection lacks `rolbypassrls`.

**Fixo email lookup missing uniqueness guard → wrong-shop binding**
`apps/gateway/src/middleware/fixo/auth.ts:60`

- Defect: legacy-customer lookup does `where(eq(email)).limit(1)` with no ORDER BY and no "exactly
  one match" check — unlike `auth.ts:67-84` / `shop-context.ts:86-104`, which require exactly one
  match specifically to avoid cross-shop mis-binding.
- Failure: two shops have a customer with the same email → Fixo session binds to whichever row
  Postgres returns first; caller sees another customer's Fixo diagnostic history and gets the wrong
  `stripeCustomerId`. No RLS backstop (fixo_sessions/reports aren't RLS-protected).
- Fix: mirror the sibling pattern — `.limit(2)`, require exactly one match, else treat as not-found.

**Deactivated mechanic keeps full access (soft-delete doesn't revoke)**
`apps/gateway/src/middleware/mechanic.ts:63` and `apps/gateway/src/middleware/shop-context.ts:76`
_(same root cause)_

- Defect: both resolve provider by `authUserId` with no `is_active` filter; the providers RLS policy
  keys only on `shop_id`, never `is_active`.
- Failure: shop fires a mechanic (`isActive=false`); their still-valid JWT continues to grant full
  shop-scoped access to orders/customers/schedule until the token expires.
- Fix: add `and(eq(authUserId), eq(isActive, true))` in both lookups (one shared helper covers both
  call sites).

**Auto-dispatch broken for all customer-initiated bookings**
`apps/agent/src/services/auto-assign.ts:79` _(reported twice — correctness + tenancy, one root
cause)_

- Defect: eligible-mechanic query runs on the bare tenant `db` under a customer-scoped tx (only
  `app.customer_id` set, never `app.shop_id`); `providers_tenant` RLS is shop_id-only, so it returns
  0 rows regardless of real availability.
- Failure: every customer self-booked appointment → `providerId=null`, "no available mechanic,"
  forcing manual admin assignment on 100% of chat-booked orders.
- Fix: apply the documented `scheduling.ts:194-201` workaround here — use `dbAdmin` + explicit
  app-level `shopFilter`.

**Mechanic dashboard stats gate on a non-existent status**
`apps/gateway/src/lib/mechanic-stats.ts:107` (and `:125`)

- Defect: `bookedMinutesForWeek`/`isOnJobNow` compare `status === "confirmed"`, a value not in the
  `order_status` enum.
- Failure: a fully-booked mechanic shows ~0% utilization and `isOnJobNow:false`; every mechanic's
  workload is misreported on the admin dashboard, no error surfaced.
- Fix: gate on the real statuses (`scheduled`, `in_progress`); fix the test fixtures that bake in
  the wrong value.

**Stripe refund over-deducts credits** `apps/agent/src/fixo/lib/stripe.ts:607`

- Defect: uses Stripe's _cumulative_ `charge.amount_refunded` as if it were the current event's
  incremental refund; idempotency guard keys on per-event id, not per-charge.
- Failure: a charge with two partial refunds ($10 then $5 on a $20 top-up) deducts on the full
  cumulative fraction each time → up to 100% of credits removed for 75% refunded; user overcharged.
- Fix: track already-refunded credits per charge (or key idempotency on charge id) and deduct only
  the delta.

**`get_availability` fail-open cross-shop disclosure** `apps/agent/src/hmls/tools/scheduling.ts:201`
_(verdict: PLAUSIBLE)_

- Defect: queries providers/availability/overrides/bookings via `dbAdmin` (always bypasses RLS) with
  `shopId ? whereShop(...) : undefined`; if `ctx.shopId` is falsy the filter drops and it returns
  platform-wide data.
- Failure: any Supabase-verified session with no email claim → `resolveCustomer` returns undefined,
  `chat.ts` proceeds with `shopId` undefined → every shop's providers/schedules/booking windows
  returned to one caller. Currently gated by disabled anonymous/phone auth providers (config.toml),
  so reachability depends on hosted auth config.
- Fix: throw/return early when `shopId` is missing instead of silently dropping the filter; stop
  non-null-asserting `user.email!` in `supabase.ts:63`.

---

## MEDIUM

**Customer's cross-shop orders hidden from list views** `apps/gateway/src/routes/portal.ts:90` (also
`:107`, `:167`, `:180`)

- Defect: the 4 list routes still AND-filter by the customer's home `shopId`; the
  detail/approve/decline/cancel handlers correctly dropped this (commit f2bcc99), but the lists
  weren't updated.
- Failure: a customer's order routed to a different shop is openable/actionable by direct ID but
  silently vanishes from My Orders/Bookings/Estimates/Quotes.
- Fix: drop the `eq(orders.shopId, shopId)` clause on the 4 list queries (RLS already scopes by
  `customer_id`).

**Negative labor/parts inputs → inverted price range** `apps/gateway/src/routes/orders.ts:168`
(contract `packages/shared/src/api/contracts/orders.ts:38-39`; same pattern `order-state.ts:300`)

- Defect: `labor_hours`/`parts_cost` have no non-negative constraint; a negative subtotal makes
  `priceRangeLowCents > priceRangeHighCents`.
- Failure: `POST /orders` with `labor_hours:-5` persists a nonsensical inverted-range order that can
  be sent to the customer.
- Fix: add `.nonnegative()` to the Zod contract (covers both call sites).

**OWNER_ALL_SHOPS sentinel compared as a uuid → 500s**
`apps/gateway/src/routes/admin-mechanics.ts:50` (also inline at `:321`, `:395`, `:628`, `:701`)

- Defect: `eq(providers.shopId, "__all__")` against a uuid column throws
  `invalid input syntax for type uuid`; `whereShop()`/`canWrite()` helpers exist for exactly this
  but aren't used.
- Failure: owner in "all shops" mode opening any single mechanic's profile/availability/orders or
  assign/delete → generic 500 instead of cross-shop read or clean 400.
- Fix: route these through `whereShop()` (reads) / `canWrite()`-style 400 guard (writes), matching
  `GET /` and `POST/PATCH`.

**`shops` table has no RLS backstop** `apps/agent/migrations/0038_tenant_app_role.sql:17`

- Defect: `shops` (per-tenant `labor_rate_cents`, `tax_rate_percent`, geo, `stripe_account_id`)
  isn't among the RLS-protected tables, yet `tenant_app` has blanket CRUD on it; isolation is 100%
  app-layer.
- Failure: any future shop-settings write path that omits `where(eq(shopId))` → staff of shop A
  read/overwrite shop B's pricing/geo/payment config, no DB catch. (No live exploit today —
  prospective.)
- Fix: enable RLS + tenant policy on `shops` like the other tenant tables.

**RLS WITH CHECK lets a customer move their own row across shops**
`apps/agent/migrations/0039_enable_rls.sql:16` (orders_tenant; same in customers_tenant)

- Defect: WITH CHECK ORs the shop-branch and customer-branch; a customer-scoped UPDATE that changes
  `shop_id` passes purely on the unchanged `customer_id` branch.
- Failure: `UPDATE orders SET shop_id=<shop-B> WHERE id=<own order>` succeeds, contradicting the
  documented "WITH CHECK blocks cross-tenant writes." Latent — no current customer write path sends
  `shopId` (app-layer whitelists mitigate).
- Fix: gate the branch — when `app.shop_id` set require shop match; else require `customer_id` match
  AND `shop_id` unchanged.

**Non-atomic security-critical migrations** `apps/agent/migrations/0039_enable_rls.sql:8` (also
0038/0040; `scripts/db-apply.sh:47`)

- Defect: 0039's 28 statements have no BEGIN/COMMIT wrapper (unlike 0016/0018), and psql runs
  without `-1`/`--single-transaction`.
- Failure: a mid-file failure (lock/permission blip) after `ENABLE RLS` but before `CREATE POLICY`
  leaves a core tenant table with RLS on and no policy → default-deny, 0 rows for every query,
  breaking that feature shop-wide until manually re-run.
- Fix: wrap these migrations in BEGIN/COMMIT (or pass `--single-transaction`).

**`recordEstimate` fires before its transaction commits → 0 rows**
`apps/agent/src/fixo/fixo-brain.ts:180`

- Defect: `openPrediction()` inserts inside the outer `withTenantScope` tx; `recordEstimate`
  (separate `dbAdmin` connection, READ COMMITTED) is fired fire-and-forget before that tx commits,
  so it can't see the row.
- Failure: essentially every priced estimate → "no prediction row matched," calibration data
  silently never recorded. (Order pricing itself is unaffected — downgraded from money to internal
  data-loss.)
- Fix: call `recordEstimate` after the outer scope commits, or write it within the same tx via the
  ALS `db`.

**Subscriber's first monthly credit grant can be dropped** `apps/agent/src/fixo/lib/stripe.ts:438`

- Defect: `invoice.payment_succeeded` skips `grantMonthly` if `tier === "free"`; Stripe doesn't
  guarantee it arrives after `customer.subscription.created` (which flips the tier). No wired
  reconciliation backfill.
- Failure: new Plus subscriber whose invoice event lands first → charged, receives 0 credits for
  that period, no auto-recovery.
- Fix: resolve tier from `invoice.subscription` via the Stripe API instead of the local profile row,
  or requeue when tier is still free.

**Item-mutation tools hardcode $140/hr instead of shop rate**
`apps/agent/src/hmls/tools/admin-order-tools.ts:383` and
`apps/agent/src/hmls/tools/customer-order-actions.ts:165`

- Defect: both hardcode `* 140 * 100`, bypassing `shopHourlyRate(shopId)` that `create_order` uses.
- Failure: any shop with a non-default `labor_rate_cents` → items added/edited after creation are
  mispriced vs the rest of the order. Masked today because both seeded shops use $140.
- Fix: use `shopHourlyRate(shopId)` in both tools.

**`resolveCustomer` on revise can orphan a customer / throw RLS violation**
`apps/agent/src/common/tools/order.ts:576`

- Defect: UPDATE path fetches `existingOrder` with only `{shopId}` (never the order's real
  `customerId`) and calls `resolveCustomer` without a `defaultShopId`; staff revises with
  `customerInfo` but no `customerId`/`ctx.customerId`.
- Failure: falls to guest-create branch → inserts a new customer (routed to fallback 'san-jose'),
  never backfills the real one; if the routed shop ≠ staff's GUC shop, the INSERT violates
  `customers_tenant` WITH CHECK and throws uncaught.
- Fix: read and pass the order's real `customerId` (and a `defaultShopId`) into `resolveCustomer` on
  the UPDATE path.

**Order revision leaves map location stale** `apps/agent/src/common/tools/order.ts:599` (also
`orders.ts:324` admin PATCH)

- Defect: revision forwards new `contactAddress` but `ItemsPatch` has no `location`/lat/lng, so
  those never re-geocode.
- Failure: mechanic dispatch card / bookings list (rendered from `order.location`, not
  `contactAddress`) show the old address after a mid-chat correction.
- Fix: re-geocode and update `location`/coords whenever `contactAddress` changes.

**Multi-service discount overrides a larger explicit discount**
`apps/agent/src/hmls/skills/estimate/pricing.ts:246`

- Defect: the `serviceCount >= 3` branch returns before `discountType` is inspected.
- Failure: staff applies `fleet` (15%) on a 3-service order → engine silently substitutes the 10%
  multi-service discount, under-discounting with a mislabeled reason.
- Fix: pick `max(multiService, requestedType)` or honor the explicit `discountType` when larger.

**`withTenantScope` holds a pooled connection during external geocode**
`packages/shared/src/db/client.ts:84` (via `with-tenant-tx.ts:31`, `portal.ts:34/223`)

- Defect: middleware wraps the whole `next()` chain in the tx; `POST /me/orders/:id/approve` awaits
  a 5s Census geocode fetch inside the open transaction.
- Failure: concurrent zip-only approvals (or a slow geocoder) pile up idle-in-transaction
  connections on the shared `tenant_app` pool → unrelated tenants' requests time out.
- Fix: geocode outside the scope (as `estimates.ts:200` already does with `dbAdmin`), or don't wrap
  slow non-DB work in the tx.

**Shared-device chat/PII leak across users on sign-out** `apps/hmls-web/hooks/useChatStorage.ts:12`
and `apps/hmls-web/components/AuthProvider.tsx:82` _(same root cause)_

- Defect: chat transcripts persist to fixed, non-user-scoped localStorage keys; sign-out
  (`Navbar.tsx:150`) only calls `supabase.auth.signOut()`, never clears storage; `AuthProvider`
  `onAuthStateChange` never touches storage.
- Failure: on a shared shop terminal, user B logging in after user A sees A's full staff-chat
  transcript (customer PII, pricing, cross-shop data) on `/admin/chat`.
- Fix: clear chat storage on `SIGNED_OUT` in `AuthProvider`, and/or namespace the key by user id.

**Deno env sync isn't idempotent for rotated secrets** `scripts/sync-deno-env.sh:38`

- Defect: only ever calls `deno deploy env add` (which errors on existing keys — `update-value` is
  the correct verb); the `|| echo` swallows per-key failure and the script still prints "Done." and
  exits 0.
- Failure: after rotating `TENANT_DATABASE_URL`/`STRIPE_SECRET_KEY`, re-running the script fails to
  update the already-present key; Deno Deploy keeps serving the stale/revoked secret while the
  operator believes sync succeeded.
- Fix: use `deno deploy env update-value` for existing keys (or delete+add); aggregate failures into
  a non-zero exit.

---

## LOW

- `apps/gateway/src/routes/orders.ts:340` — the "No fields to update" 400 guard is dead code
  (`directUpdates.length` is provably 0 or ≥2, never 1); empty PATCH returns 200 no-op instead
  of 400. Fix: check length before adding `updatedAt`.
- `apps/gateway/src/routes/orders.ts:512` — `orderInShop()` uses `eq(shopId, "__all__")`, so
  `GET /:id/events` 404s for an owner-all-shops who can open the order itself. Fix: use
  `whereShop()` for this read.
- `apps/gateway/src/routes/admin.ts:330` — `DELETE /customers/:id` lacks the OWNER_ALL_SHOPS guard
  its POST/PATCH siblings have → ugly 500 instead of clean 400 (fails safe, no leak). Fix: add the
  same guard.
- `apps/gateway/src/middleware/mechanic.ts:55` — dual-role admin+mechanic account gets `providerId`
  (shop B) vs `shopId` (shop A) mismatch → mechanic routes silently 0-row/500. Fix: reconcile or
  reject the mismatch explicitly.
- `apps/agent/src/hmls/tools/scheduling.ts:201` (owner-all-shops variant, PLAUSIBLE) — blended
  cross-shop availability with no per-slot shop attribution can misinform a later scheduling
  decision (graceful unassigned fallback, not a leak). Fix: attach shop to each slot or require a
  selected shop.
- `apps/agent/src/fixo/fixo-brain.ts:65` — `fillPrediction` lacks the `.returning()`/row-count check
  its siblings have; a rolled-back prediction row silently discards a ~5s LLM diagnosis with no log.
  Fix: check affected rows and warn.
- `apps/agent/src/fixo/fixo-brain.ts:142` — `recordOutcome` ownership check lets NULL-owner
  (HMLS-internal) predictions be overwritten by any Fixo API-key holder who has the UUID. Fix:
  reject when caller key doesn't own a null-owner row (or scope internal predictions).
- `apps/agent/src/fixo/lib/stripe.ts:104` — Price-ID cache never invalidates; a Dashboard price
  rotation (the documented zero-deploy flow) leaves warm instances handing out an archived price id
  until restart. Fix: add a TTL or re-validate on miss.

---

## THEMES

1. **OWNER_ALL_SHOPS sentinel mishandled** (`admin-mechanics.ts:50/321/395/628/701`, `admin.ts:330`,
   `orders.ts:512`, `scheduling.ts` low). The `whereShop()`/`canWrite()` helpers exist precisely to
   handle `"__all__"`, but many call sites hand-roll `eq(shopId, ...)` against a uuid column → 500s
   or spurious 404s for the owner persona. **Sweep every `eq(schema.*.shopId, shopId)` and route it
   through the helpers.**

2. **Customer-scoped GUC vs shop-only RLS on `providers`.** "Customer identity wins" means
   `app.shop_id` is never set, so any shop-scoped `providers` query on the tenant `db` returns 0
   rows (`auto-assign.ts`). `scheduling.ts:194` already worked around this with `dbAdmin`+filter;
   the fix wasn't propagated. **Audit every `providers`/shop-keyed query reachable from a
   customer-scoped tx.**

3. **Client-side storage never cleared on sign-out** (`useChatStorage`, `AuthProvider`,
   `orders/page.tsx` sessionStorage). Fixed, non-user-scoped keys + a sign-out that only nulls React
   state → shared-device PII leakage. **One `SIGNED_OUT` cleanup handler fixes the class.**

4. **Config-driven money values bypassed after order creation** (hardcoded `$140/hr` in two item
   tools; multi-service discount overriding explicit types; unvalidated negative inputs). Pricing is
   correct at `create_order` but drifts on every mutation path. **Route all repricing through
   `shopHourlyRate`/`calculateDiscount` with the same guards.**

5. **Fail-open escape hatches around a fail-closed model** (`SKIP_AUTH` no env guard, `tenantDb()`
   silent service_role fallback). The RLS design is fail-closed by default, but these two paths
   silently invert that on a single env misconfig — the highest-leverage things to add boot-time
   assertions for.

---

## Clean bill

The tenancy foundation itself held up well under scrutiny:

- **The 7-table RLS `USING` policies are correct.** The customer-cross-shop read design
  (`customer_id = app.customer_id` OR `shop_id = app.shop_id`) does exactly what's documented, and
  the `provider_availability`/`provider_schedule_overrides` policies correctly enforce shop
  isolation transitively via the `providers` EXISTS subquery.
- **Fail-closed is real.** Nearly every bare-`db` scoping mistake found (auto-assign, the mismatched
  dual-role path, the sentinel-vs-uuid comparisons) fails to _zero rows or an error_, not to
  cross-tenant data. The default-deny posture is doing its job.
- **`dbAdmin`/`db` separation is disciplined** — owner-all reads, bootstrap, and legitimate
  cross-shop routing (`shop-routing.ts`, `shopHourlyRate`) correctly use `dbAdmin`, and
  staff/customer request paths correctly use the scoped client.
- **The `withTenantScope` / `withTenantTx` / AsyncLocalStorage plumbing is coherent** and the GUC
  precedence rule is applied consistently (the auto-assign bug is a _missing_ propagation of a known
  workaround, not a broken primitive).
- The two RLS-layer caveats (WITH CHECK OR-branch, `shops` not protected) are **latent, not live** —
  no current code path reaches them; they're defense-in-depth gaps worth closing, not open holes.

No cross-tenant _read_ leak is exploitable through application code today without an additional
precondition (auth misconfig, missing env var, or a not-yet-written write path). The residual risk
is concentrated in the fail-open escape hatches (theme 5) and the non-tenancy money/correctness bugs
above.
