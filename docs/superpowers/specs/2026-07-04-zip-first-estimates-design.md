# Zip-First Estimates + Address-at-Approval — Design Spec

**Date:** 2026-07-04 **Status:** Approved in conversation (user locked both product forks) →
writing-plans. **Relates to:** multi-tenancy Phase 1/2 (shop routing, RLS), area-shop-bridge plan.

## Problem

The customer chat path requires a **full street address before an estimate can even be created**
(`create_order` `isCustomerSide` check). But an estimate needs only a shop (for the labor rate) and
shop routing needs only ~zip-level precision (80 km service-radius circles). Forcing the address up
front is a real drop-off point for privacy-shy users. The precise address is only genuinely needed
when a mechanic is dispatched.

Separately, `customers.shop_id` is stamped by defaults (signup trigger / chat first-contact →
`san-jose`), never by geography — an Orange County customer sits in San Jose's customer list
forever, and (existing bug) the portal approve/decline handlers assert
`order.shopId == customer home shopId`, so a customer cannot approve their own order when it was
routed to a different shop than their stale home shop.

## Locked decisions (user, 2026-07-04)

1. **Zip is enough for an estimate.** Customer path requires phone AND (address OR 5-digit zip). Zip
   routes the order via a static zip-centroid table → `nearestShop` (existing radius logic).
2. **Full address is collected at portal approval.** If an order has only zip-precision location,
   the customer must supply the street address as part of Approve (modal in portal; API rejects
   approve without it). No staff phone-chasing, no chat follow-up.
3. **First-order claiming (included).** When a customer with zero prior orders gets their first
   order, `customers.shop_id` is synced to that order's shop (system correction via `dbAdmin`).
4. **No re-routing at approval.** If the full address geocodes outside the assigned shop's radius,
   keep the shop and flag for staff review (existing `adminNotes` review-note pattern). Staff sees
   the address before dispatch anyway.

## Design

### 1. Zip → coords: static ZCTA centroid table (no API, no key)

- `scripts/gen-zip-centroids.ts` — one-shot generator: downloads the US Census **ZCTA Gazetteer**
  file (public domain), emits `apps/agent/src/common/data/zip-centroids.json`
  (`{ "95112": [37.3541, -121.8828], ... }`, ~41k entries, coords rounded to 4 decimals, ~700 KB).
  The generated JSON is **committed**; the script is for regeneration only.
- `zipToCoords(zip: string): Coords | null` in `shop-routing.ts` — normalizes to 5 digits, looks up
  the table (static JSON import). Reuses the existing `Coords` type and `nearestShop`.

### 2. `create_order` (customer path)

- New optional param `serviceZip` (5-digit string) on the tool schema.
- Requirement relaxes to: phone AND (address OR serviceZip). Error message updated so the agent asks
  for "zip code (or full address)".
- Routing: address present → existing `routeOrderToShop(address)`; else zip →
  `zipToCoords(serviceZip)` → `nearestShop` (same fallback-to-primary + `routingReviewNote` shape).
- Storage: **zero schema change.** `location` stores the address if given, else the bare zip string.
  Zip-centroid coords go to `locationLat/Lng` as usual. "Zip-only precision" is derived by format
  (`/^\d{5}(-\d{4})?$/` on `location`), exposed to clients as a server-computed flag — not a column.
- Agent skill markdown (`.skills/order/`) updated: collect zip for the estimate; explain the street
  address will be asked at booking time.

### 3. Portal approval collects the address

- `POST /me/orders/:id/approve` accepts an optional JSON body `{ address?: string }`.
  - Order location is zip-only and no address → **400 `ADDRESS_REQUIRED`** (approve blocked).
  - Address provided → best-effort geocode; update `location` (+`locationLat/Lng` when geocoded); if
    the geocoded point falls outside the assigned shop's radius (or geocode fails), append a review
    note to `adminNotes` (no re-route). Then run the existing `transition(approved)`.
- Order detail API response gains `needsAddress: boolean` (status `estimated` && zip-only location)
  so the portal UI knows to open the address modal on Approve.
- Portal web UI: Approve button opens an address input when `needsAddress`; submits it with the
  approve call.

### 4. Fix: customer cross-shop own-order access in portal

Drop the `eq(orders.shopId, shopId)` clause from the customer-ownership checks in portal
approve/decline (and any sibling customer-owned reads found by grep) — ownership is
`order.customerId == authed customerId`, which is exactly what the RLS `app.customer_id` policy
backs. A customer's orders are theirs **across shops** (locked Phase-1/2 design). Staff-side scoping
is untouched.

### 5. First-order claiming

In `create_order` INSERT path, after the order lands: if the customer has **zero other orders**,
sync `customers.shop_id` to the new order's `shopId` (skip when equal). System correction →
`dbAdmin` (deliberate cross-shop write; the RLS customer policy would otherwise block moving a row
between shops). Best-effort: a failure logs and never breaks order creation.

## Out of scope

- City-page → chat region pre-routing (`REGIONS.shopSlug` threading) — still deferred.
- Re-routing orders when the approval address lands in another shop's radius (flag only).
- Zip collection at signup; per-tenant customer rows (Phase 3).

## Testing

- Unit: `zipToCoords` (hit / miss / normalization); zip-path routing (centroid → nearestShop);
  zip-only-location detection.
- Gateway: approve with zip-only order and no address → 400 `ADDRESS_REQUIRED`; with address →
  location updated + transition runs; cross-shop own-order approve now succeeds.
- Agent: create_order accepts zip-only customer flow (missing-fields error message covers both).
- Claiming: first order claims; second order never moves the customer.
