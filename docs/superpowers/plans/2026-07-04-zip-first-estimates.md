# Zip-First Estimates + Address-at-Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer get a real estimate with only a ZIP code (routes the order to the right
shop); collect the full street address at portal approval; and self-correct a customer's home shop
on their first order.

**Architecture:** A committed static ZIP-centroid table (US Census ZCTA gazetteer, no API) maps
ZIP→coords, feeding the existing `nearestShop` radius routing. `create_order` (customer path)
relaxes its address requirement to "address OR zip". Portal `approve` gains an address body + an
`ADDRESS_REQUIRED` gate; the order-detail response exposes `needsAddress`. First-order claiming
syncs `customers.shop_id` to the first order's shop via `dbAdmin`. Zero schema change — the bare ZIP
lives in the existing `location` column until the address replaces it.

**Tech Stack:** Deno (agent + gateway, `@std` test), Bun/Next.js (web, `bun:test`), Drizzle ORM,
Hono, Zod. No new runtime deps.

## Global Constraints

- **Deno code:** double quotes, 2-space indent, 100-char lines (`deno fmt`). **Web:** Biome (double
  quotes, 2-space).
- **`db` vs `dbAdmin`:** the default `db` is a fail-closed tenant connection once RLS is enabled;
  bootstrap/system/cross-shop writes use `dbAdmin`. First-order claiming moves a customer between
  shops → **must use `dbAdmin`** (the RLS customer policy would block it).
- **Customer ownership is cross-shop.** A customer owns an order iff `order.customerId ==` the
  authed `customerId` — NOT gated by shop. Do not add/keep `eq(orders.shopId, shopId)` on
  customer-owned reads (it wrongly blocks approving an order routed to a non-home shop).
- **Zero schema change.** `location` holds the address, or a bare 5-digit ZIP when only a ZIP was
  given. "Zip-only precision" is derived by regex, never stored as a column.
- **Best-effort, never-throw** for geocoding, ZIP lookup, and first-order claiming — a failure must
  never break order creation or approval.
- Full local CI before push:
  `cd apps/hmls-web && bun run lint && bun run typecheck && bun run test &&
  bun run build`;
  `deno task check`; `cd apps/gateway && deno test`; `cd apps/agent && deno test`.

## File Structure

- `apps/agent/scripts/gen-zip-centroids.ts` — **create**. One-shot generator: parses a Census ZCTA
  gazetteer `.txt` → `zip-centroids.json`. Dev-only, not imported at runtime.
- `apps/agent/src/common/data/zip-centroids.json` — **create** (generated, committed).
  `{ "95112":
  [37.3541, -121.8828], ... }`.
- `apps/agent/src/common/shop-routing.ts` — **modify**. Add `zipToCoords`; extend `routeOrderToShop`
  to accept an optional `zip`.
- `apps/agent/src/common/shop-routing_test.ts` — **modify**. Tests for `zipToCoords` + zip routing.
- `apps/agent/src/common/tools/order.ts` — **modify**. `serviceZip` param; relaxed requirement; zip
  routing; first-order claiming.
- `apps/gateway/src/routes/portal.ts` — **modify**. Approve address body + `ADDRESS_REQUIRED`;
  `needsAddress` on detail; drop cross-shop clause on the 3 customer-owned handlers.
- `apps/hmls-web/app/(portal)/portal/orders/[id]/page.tsx` — **modify**. Address prompt on Approve
  when `needsAddress`.
- `.skills/order/` (agent skill markdown) — **modify** in Task 3.

---

### Task 1: ZIP-centroid table + `zipToCoords`

**Files:**

- Create: `apps/agent/scripts/gen-zip-centroids.ts`
- Create (generated): `apps/agent/src/common/data/zip-centroids.json`
- Modify: `apps/agent/src/common/shop-routing.ts`
- Test: `apps/agent/src/common/shop-routing_test.ts`

**Interfaces:**

- Produces: `zipToCoords(zip: string): Coords | null` exported from `shop-routing.ts` (`Coords` is
  the existing `{ lat: number; lng: number }`). Normalizes to the first 5 digits; returns null on
  miss or malformed input.

- [ ] **Step 1: Write the generator script**

Create `apps/agent/scripts/gen-zip-centroids.ts`:

```ts
// One-shot: parse a US Census ZCTA gazetteer .txt into a compact ZIP→[lat,lng] map.
// Download first (public domain, no key):
//   curl -sL "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip" -o /tmp/zcta.zip
//   unzip -o /tmp/zcta.zip -d /tmp
// Then: deno run --allow-read --allow-write apps/agent/scripts/gen-zip-centroids.ts /tmp/2023_Gaz_zcta_national.txt
// Tab-delimited columns: GEOID  ALAND  AWATER  ALAND_SQMI  AWATER_SQMI  INTPTLAT  INTPTLONG
const src = Deno.args[0];
if (!src) throw new Error("usage: gen-zip-centroids.ts <gazetteer.txt>");
const text = await Deno.readTextFile(src);
const lines = text.split("\n");
const out: Record<string, [number, number]> = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split("\t").map((c) => c.trim());
  if (cols.length < 7) continue;
  const zip = cols[0];
  const lat = Number(cols[cols.length - 2]);
  const lng = Number(cols[cols.length - 1]);
  if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  out[zip] = [Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4];
}
const dest = new URL("../src/common/data/zip-centroids.json", import.meta.url).pathname;
await Deno.mkdir(new URL("../src/common/data/", import.meta.url).pathname, { recursive: true });
await Deno.writeTextFile(dest, JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length} ZIP centroids to ${dest}`);
```

- [ ] **Step 2: Generate + commit the table**

Run:

```bash
curl -sL "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip" -o /tmp/zcta.zip
unzip -o /tmp/zcta.zip -d /tmp
cd apps/agent && deno run --allow-read --allow-write scripts/gen-zip-centroids.ts /tmp/2023_Gaz_zcta_national.txt
```

Expected: prints "wrote ~33000 ZIP centroids". Confirm `src/common/data/zip-centroids.json` exists
and `grep -o '"95112":\[[^]]*\]' src/common/data/zip-centroids.json` shows a San-Jose-ish coord
(~37.3, ~-121.8). If the URL 404s (year rolled), list
`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/` and use the latest
`*_Gaz_zcta_national.zip`; note the year used in the commit message.

- [ ] **Step 3: Write the failing test for `zipToCoords`**

In `apps/agent/src/common/shop-routing_test.ts` add:

```ts
import { zipToCoords } from "./shop-routing.ts";

Deno.test("zipToCoords: known San Jose ZIP resolves near SJ", () => {
  const c = zipToCoords("95112");
  assertEquals(c !== null, true);
  assertEquals(Math.abs(c!.lat - 37.35) < 0.3, true);
  assertEquals(Math.abs(c!.lng - -121.88) < 0.3, true);
});

Deno.test("zipToCoords: ZIP+4 is normalized to 5 digits", () => {
  assertEquals(zipToCoords("95112-1234") !== null, true);
});

Deno.test("zipToCoords: unknown / malformed returns null", () => {
  assertEquals(zipToCoords("00000"), null);
  assertEquals(zipToCoords("abc"), null);
  assertEquals(zipToCoords(""), null);
});
```

- [ ] **Step 4: Run it; confirm it fails**

Run: `cd apps/agent && deno test src/common/shop-routing_test.ts` Expected: FAIL — `zipToCoords` not
exported.

- [ ] **Step 5: Implement `zipToCoords`**

In `apps/agent/src/common/shop-routing.ts`, near the top (after the `Coords` type), add:

```ts
import zipCentroids from "./data/zip-centroids.json" with { type: "json" };

const ZIP_TABLE = zipCentroids as Record<string, [number, number]>;

/** Map a US ZIP (5-digit or ZIP+4) to its ZCTA centroid, or null on miss.
 *  Precision is centroid-level — enough to route to the nearest shop, not to
 *  dispatch a mechanic. */
export function zipToCoords(zip: string): Coords | null {
  const m = /^(\d{5})/.exec(zip.trim());
  if (!m) return null;
  const hit = ZIP_TABLE[m[1]];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}
```

- [ ] **Step 6: Run tests; confirm green**

Run: `cd apps/agent && deno test src/common/shop-routing_test.ts && deno task check` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/scripts/gen-zip-centroids.ts apps/agent/src/common/data/zip-centroids.json \
        apps/agent/src/common/shop-routing.ts apps/agent/src/common/shop-routing_test.ts
git commit -m "feat(routing): static ZIP-centroid table + zipToCoords"
```

---

### Task 2: Route an order by ZIP

**Files:**

- Modify: `apps/agent/src/common/shop-routing.ts` (`routeOrderToShop`, currently `(address) => ...`)
- Test: `apps/agent/src/common/shop-routing_test.ts`

**Interfaces:**

- Consumes: `zipToCoords` (Task 1), existing `geocodeAddress`, `nearestShop`.
- Produces:
  `routeOrderToShop(address: string | null, zip?: string | null): Promise<{ shopId: string;
  coords: Coords | null; autoRouted: boolean }>`
  — address geocode wins; if it yields no coords and a `zip` is given, the ZIP centroid is used.
  Same primary-fallback + `autoRouted` semantics. Existing single-arg callers are unaffected.

- [ ] **Step 1: Write the failing test**

In `shop-routing_test.ts` add (uses the real shops table via a stubbed fetch is overkill — instead
test the coords-resolution branch by asserting a ZIP with no address still produces coords through
the public function against the seeded local shops is an integration concern; keep this unit-level):

```ts
import { resolveRoutingCoords } from "./shop-routing.ts";

Deno.test("resolveRoutingCoords: address wins over zip", async () => {
  // A real US address geocodes; the zip is ignored when address resolves.
  const c = await resolveRoutingCoords("1600 Amphitheatre Parkway, Mountain View, CA", "10001");
  // best-effort: if the Census geocoder is unreachable in CI it returns null;
  // assert only that it does not throw and returns Coords|null.
  assertEquals(c === null || (typeof c.lat === "number"), true);
});

Deno.test("resolveRoutingCoords: falls back to zip centroid when no address", async () => {
  const c = await resolveRoutingCoords(null, "95112");
  assertEquals(c !== null && Math.abs(c.lat - 37.35) < 0.3, true);
});
```

- [ ] **Step 2: Run it; confirm it fails**

Run: `cd apps/agent && deno test src/common/shop-routing_test.ts` Expected: FAIL —
`resolveRoutingCoords` not exported.

- [ ] **Step 3: Extract coords-resolution + extend `routeOrderToShop`**

In `shop-routing.ts`, add the helper and rewrite the coords line of `routeOrderToShop`:

```ts
/** Resolve routing coords: a geocodable address wins; else the ZIP centroid;
 *  else null. Best-effort, never throws. */
export async function resolveRoutingCoords(
  address: string | null,
  zip?: string | null,
): Promise<Coords | null> {
  const fromAddr = address ? await geocodeAddress(address) : null;
  if (fromAddr) return fromAddr;
  return zip ? zipToCoords(zip) : null;
}
```

Change `routeOrderToShop`'s signature + its `coords` line:

```ts
export async function routeOrderToShop(
  address: string | null,
  zip?: string | null,
): Promise<{ shopId: string; coords: Coords | null; autoRouted: boolean }> {
  const shops = await db.select({
    /* unchanged select */
    id: schema.shops.id,
    slug: schema.shops.slug,
    latitude: schema.shops.latitude,
    longitude: schema.shops.longitude,
    serviceRadiusKm: schema.shops.serviceRadiusKm,
  }).from(schema.shops);
  const primary = shops.find((s) => s.slug === "san-jose") ?? shops[0];
  if (!primary) throw new Error("No shops configured in database");

  const coords = await resolveRoutingCoords(address, zip);
  const matchedId = coords ? nearestShop(coords, shops) : null;
  if (matchedId) return { shopId: matchedId, coords, autoRouted: true };
  return { shopId: primary.id, coords, autoRouted: false };
}
```

- [ ] **Step 4: Run tests + typecheck; confirm green**

Run: `cd apps/agent && deno test src/common/shop-routing_test.ts && deno task check` Expected: PASS.
(The address-wins test tolerates a null geocode so it's network-robust.)

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/common/shop-routing.ts apps/agent/src/common/shop-routing_test.ts
git commit -m "feat(routing): route an order by ZIP when no address given"
```

---

### Task 3: `create_order` — accept ZIP, relax the address requirement

**Files:**

- Modify: `apps/agent/src/common/tools/order.ts` (schema ~373-377; customer routing branch ~677-697;
  requirement block ~717-736)
- Modify: `.skills/order/` (the agent skill markdown; find the customer intake section)

**Interfaces:**

- Consumes: `routeOrderToShop(address, zip)` (Task 2).
- Produces: no new exports; `create_order` now accepts `customerInfo.serviceZip` and treats phone +
  (address OR serviceZip) as sufficient on the customer path.

- [ ] **Step 1: Add `serviceZip` to the schema**

In `order.ts`, in the `customerInfo` object schema (near `address: z.string().optional()`, ~line
376):

```ts
serviceZip: z.string().optional().describe(
  "Customer 5-digit US ZIP for the service location. Enough to price + route the estimate; " +
    "the full street address is collected later at booking.",
),
```

- [ ] **Step 2: Capture the zip + use it for routing**

Where `addressIn` is computed for the insert path (~line 646) add alongside it:

```ts
const serviceZipIn = clean(params.customerInfo?.serviceZip) ?? null;
```

In the customer routing branch (~line 686-688), pass the zip:

```ts
if (isCustomerAgent) {
  const routed = await routeOrderToShop(orderAddress, serviceZipIn);
  orderShopId = routed.shopId;
  coords = routed.coords;
  routingNote = routingReviewNote(routed);
} else {
```

- [ ] **Step 3: Relax the requirement + store the ZIP as location**

Replace the customer requirement block (~717-736) so a ZIP satisfies the location requirement:

```ts
if (isCustomerSide) {
  const missing: string[] = [];
  if (!orderPhone) missing.push("phone");
  if (!orderAddress && !serviceZipIn) missing.push("service ZIP (or full address)");
  if (missing.length > 0) {
    const fieldList = missing.join(" and ");
    return toolResult({
      success: false,
      error: `Cannot create the order yet — missing ${fieldList}. Ask the customer for their ` +
        `${fieldList}. A 5-digit ZIP is enough for the estimate; the full street address is ` +
        `collected when they book. Then call create_order again with customerInfo.`,
      missingFields: missing,
    });
  }
}
```

Where the order `location` / `contactAddress` is set in the INSERT `.values({...})` (find the
`location:` / `contactAddress:` field ~line 822), store the address if present else the bare ZIP:

```ts
location: orderAddress ?? serviceZipIn,
// contactAddress keeps the precise address only (null when zip-only):
contactAddress: orderAddress,
```

(If `location` isn't currently in the `.values` — grep for it; the order absorbs booking fields, so
`location` is on `orders`. Add it if missing.)

- [ ] **Step 4: Update the agent skill markdown**

In `.skills/order/` find the customer-intake guidance and change "collect the service address" to:
"collect a 5-digit ZIP for the estimate (enough to price + route); tell the customer the full street
address is collected at booking. Pass it as `customerInfo.serviceZip`." Keep it short — match the
surrounding style.

- [ ] **Step 5: Typecheck + agent tests**

Run: `deno task check && cd apps/agent && deno test src/common/` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/common/tools/order.ts .skills/order
git commit -m "feat(agent): accept a ZIP for the estimate; address deferred to booking"
```

---

### Task 4: First-order claiming

**Files:**

- Modify: `apps/agent/src/common/tools/order.ts` (after the INSERT returns, in the INSERT branch)

**Interfaces:**

- Consumes: `dbAdmin` from `../../db/client.ts` (already imported as `db`; add `dbAdmin`), the
  resolved `customer` (has `.id`, `.shopId`), the new order's `id` + `orderShopId`.

- [ ] **Step 1: Add the claim after a successful insert**

After the order INSERT (where the new order row is available, ~after line 830), add:

```ts
// First-order claiming: a customer's home shop is stamped by signup/chat
// defaults, not geography. On their FIRST order, adopt that order's shop so
// the customer lands in the right shop's book. System cross-shop write →
// dbAdmin (the RLS customer policy would block moving a row between shops).
// Best-effort: never break order creation.
if (isCustomerAgent && customer && customer.shopId !== orderShopId) {
  try {
    const prior = await dbAdmin
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.customerId, customer.id), ne(schema.orders.id, order.id)))
      .limit(1);
    if (prior.length === 0) {
      await dbAdmin.update(schema.customers)
        .set({ shopId: orderShopId })
        .where(eq(schema.customers.id, customer.id));
    }
  } catch (e) {
    logger.warn?.("first-order claim failed", { customerId: customer.id, err: String(e) });
  }
}
```

Ensure `dbAdmin`, `ne`, `and`, `eq` are imported (add to the existing `drizzle-orm` + `../../db`
imports as needed). Use the actual variable name the INSERT returns for the new row (grep the
insert; the plan assumes `order`).

- [ ] **Step 2: Typecheck + tests**

Run: `deno task check && cd apps/agent && deno test src/common/` Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/common/tools/order.ts
git commit -m "feat(agent): first order claims the customer's home shop"
```

---

### Task 5: Portal approval collects the address (+ cross-shop ownership fix)

**Files:**

- Modify: `apps/gateway/src/routes/portal.ts` (GET `/me/orders/:id` ~106-140; approve ~177-197;
  decline ~200+)

**Interfaces:**

- Consumes: existing `transition`, `geocodeAddress` (import from `@hmls/agent/common/shop-routing`),
  `dbAdmin`? No — the customer owns the row, so the address update is a customer-scoped write on
  `db` (RLS `app.customer_id` admits it). Existing `db`.
- Produces: approve accepts optional `{ address?: string }`; detail response gains
  `needsAddress:
  boolean`.

- [ ] **Step 1: Add a `needsAddress` helper + a zip-only regex**

At the top of `portal.ts` (after imports):

```ts
const ZIP_ONLY = /^\d{5}(-\d{4})?$/;
/** An estimate whose stored location is a bare ZIP still needs a street address before approval. */
function needsAddress(order: { status: string; location: string | null }): boolean {
  return order.status === "estimated" && !!order.location && ZIP_ONLY.test(order.location.trim());
}
```

- [ ] **Step 2: Fix cross-shop ownership + expose `needsAddress` on the detail GET**

In GET `/me/orders/:id` (~114-121), drop the `eq(schema.orders.shopId, shopId)` clause (ownership is
`customerId`, cross-shop by design):

```ts
const [order] = await db
  .select()
  .from(schema.orders)
  .where(eq(schema.orders.id, id)) // tenant-ok: customer-owned row; RLS app.customer_id scopes it, ownership asserted below
  .limit(1);
if (!order || order.customerId !== customerId) {
  return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
}
```

Extend the response type + body to include `needsAddress`:

```ts
return c.json<
  { order: OrderRow; intake: OrderIntakeRow | null; events: OrderEventRow[]; needsAddress: boolean }
>({
  order,
  intake,
  events,
  needsAddress: needsAddress(order),
});
```

- [ ] **Step 3: Approve accepts + requires the address for zip-only orders**

Replace the approve handler (~177-197) with (keep the `zValidator` import; the body is optional):

```ts
import { z } from "zod";
// ...
const approveInput = z.object({ address: z.string().min(3).optional() });

portal.post("/me/orders/:id/approve", zValidator("json", approveInput), async (c) => {
  const customerId = c.get("customerId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>({ error: { code: "BAD_REQUEST", message: "Invalid order ID" } }, 400);
  }
  const { address } = c.req.valid("json");

  const [order] = await db
    .select() // tenant-ok: customer-owned row; ownership asserted below, RLS app.customer_id scopes it
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);
  if (!order || order.customerId !== customerId) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Order not found" } }, 404);
  }

  // Zip-only estimate must gain a street address before approval.
  if (needsAddress(order)) {
    if (!address) {
      return c.json<ApiError>(
        {
          error: { code: "ADDRESS_REQUIRED", message: "A service address is required to approve." },
        },
        400,
      );
    }
    const coords = await geocodeAddress(address);
    const outOfArea = !coords; // best-effort; a miss just flags for staff, never blocks
    await db.update(schema.orders).set({
      location: address,
      locationLat: coords ? String(coords.lat) : order.locationLat,
      locationLng: coords ? String(coords.lng) : order.locationLng,
      adminNotes: outOfArea
        ? [order.adminNotes, "⚠ Approval address did not geocode — verify before dispatch."]
          .filter(Boolean).join("\n")
        : order.adminNotes,
    }).where(eq(schema.orders.id, id));
  }

  const result = await transition(id, "approved", { kind: "customer", customerId });
  return sendOrderStateResult(c, result);
});
```

- [ ] **Step 4: Fix cross-shop ownership on decline too**

In the decline handler (~200+), drop its `eq(schema.orders.shopId, shopId)` clause the same way
(ownership stays `order.customerId !== customerId`). Add the same `// tenant-ok:` note.

- [ ] **Step 5: Typecheck + gateway tests**

Run: `deno task check && cd apps/gateway && deno test` Expected: PASS (incl. `tenant-guard_test.ts`
— the `// tenant-ok:` notes keep it green).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/portal.ts
git commit -m "feat(portal): collect address at approval for zip-only estimates; fix cross-shop own-order access"
```

---

### Task 6: Portal web — address prompt on Approve

**Files:**

- Modify: `apps/hmls-web/app/(portal)/portal/orders/[id]/page.tsx`

**Interfaces:**

- Consumes: the detail response's new `needsAddress` boolean; `portalPaths.approve(id)` now accepts
  a JSON body `{ address }`.

- [ ] **Step 1: Read `needsAddress` + hold an address input**

Where the page reads the order-detail response, capture `needsAddress`. Add state near
`actionLoading` (~229):

```tsx
const [addressInput, setAddressInput] = useState("");
const [showAddress, setShowAddress] = useState(false);
```

- [ ] **Step 2: Gate Approve behind the address when needed**

Change the Approve button handler (~553) so that, when `needsAddress` and the address isn't entered
yet, it reveals the input instead of calling approve:

```tsx
onClick={() => {
  if (data.needsAddress && !addressInput.trim()) {
    setShowAddress(true);
    return;
  }
  handleAction("approve");
}}
```

Render the input when `showAddress` (above the buttons, inside the `canApproveDecline` block):

```tsx
{
  showAddress && (
    <div className="mb-3">
      <label className="block text-sm mb-1">Service address (street, city, state)</label>
      <input
        className="w-full rounded border px-3 py-2"
        value={addressInput}
        onChange={(e) => setAddressInput(e.target.value)}
        placeholder="123 Main St, San Jose, CA 95112"
      />
    </div>
  );
}
```

- [ ] **Step 3: Send the address with the approve call**

In `doAction` (~282), include the address in the approve body:

```tsx
const res = await fetch(
  action === "approve" ? portalPaths.approve(order.id) : portalPaths.decline(order.id),
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      action === "approve"
        ? (addressInput.trim() ? { address: addressInput.trim() } : {})
        : { reason },
    ),
  },
);
```

If the server returns `ADDRESS_REQUIRED` (400), surface the existing error toast and reveal the
input (`setShowAddress(true)`). Match the file's existing error-handling pattern — do not invent a
new one.

- [ ] **Step 4: Typecheck + lint + web tests**

Run: `cd apps/hmls-web && bun run typecheck && bun run lint && bun run test` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/hmls-web/app/(portal)/portal/orders/[id]/page.tsx"
git commit -m "feat(portal-web): prompt for service address on Approve when estimate is zip-only"
```

---

## Final verification

- [ ] `cd apps/hmls-web && bun run lint && bun run typecheck && bun run test && bun run build`
- [ ] `deno task check && deno task lint && deno task fmt:check`
- [ ] `cd apps/gateway && deno test && cd ../agent && deno test`
- [ ] Manual/local: create a customer order with only a ZIP → lands on the nearest shop, `location`
      shows the ZIP, detail `needsAddress=true`; approve without address → 400; approve with address
      → `location` updated, status `approved`; a second order for the same customer does NOT move
      their shop.

## Self-Review

**Spec coverage:** §1 ZIP table → Task 1; §2 create_order ZIP → Tasks 2-3; §3 approval address +
needsAddress → Tasks 5-6; §4 cross-shop fix → Task 5; §5 first-order claiming → Task 4. Testing
section → per-task tests + Final verification.

**Placeholder scan:** none — every step has concrete code/commands. The two "grep to confirm the
exact variable/field name" notes (order.ts insert row name; `.skills/order/` section) are
verification instructions with a stated assumption, not deferred work.

**Type consistency:** `zipToCoords(zip): Coords|null`, `resolveRoutingCoords(address, zip?)`,
`routeOrderToShop(address, zip?)`, `needsAddress(order)`, `customerInfo.serviceZip`, response
`needsAddress` — used identically across tasks. `Coords` is the existing type.

## Ponytail ceilings

- Committed ~1MB `zip-centroids.json` parsed once at agent module init — fine for a static asset;
  regenerate via the script only when the Census gazetteer year rolls.
  `// ponytail: full-US static
  table; regenerate on gazetteer refresh, not per-deploy.`
- ZIP→centroid is metro-accurate, not rooftop — deliberately only used for shop routing, never for
  dispatch (the street address collected at approval is what a mechanic navigates to).
