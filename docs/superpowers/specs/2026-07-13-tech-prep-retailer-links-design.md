---
title: Tech prep retailer links and sourced prices
date: 2026-07-13
status: approved
depends_on: 2026-07-13-tavily-deepseek-part-search-design.md
---

# Tech prep retailer links and sourced prices

## Problem and scope

Mobile mechanics usually obtain job-specific parts after an appointment is requested. The existing
manual **Look up part numbers** action identifies grounded OEM and aftermarket references, but it
does not help staff move from a compatible number to a retailer. Staff need useful paths to
AutoZone, O'Reilly Auto Parts, NAPA, Walmart, and Amazon without a separate automatic workflow.

Extend the existing manual action so the same click returns grounded part references plus
best-effort retailer product links and sourced prices. Keep the feature stateless, browser-local,
and manually triggered. It must not claim that a product is in stock, available for pickup, or able
to arrive on a particular date.

## User experience

The existing OEM and aftermarket reference cards remain the primary result and continue to be
grouped by service and engine variant. Each group gains a compact **Where to buy** section beneath
its references.

A verified retailer offer displays:

- retailer name;
- product title and product or part number;
- price only when it is grounded in the retailer evidence;
- Amazon rating only when a grounded rating of at least 4.0 is present; and
- a direct HTTPS product-page link.

The section displays no more than five verified offers for an engine variant and no more than two
offers from one retailer. The interface does not show "available now," "pickup today," delivery
dates, or other inventory claims.

If fewer than five verified offers survive validation, fill the remaining positions with retailer
search links. A fallback is labeled **Search AutoZone**, **Search O'Reilly**, **Search NAPA**,
**Search Walmart**, or **Search Amazon**, not as a product. It has no displayed price, rating, or
fitment claim. This gives staff multiple useful retailer paths without fabricating a product.

If no engine variant or part reference can be verified, show five fallback searches in a clearly
labeled **Engine not verified** group. Build those searches from the vehicle and service name, and
retain the fitment warning. A successful Tavily response therefore never leaves staff with zero or
only one actionable retailer path merely because direct product evidence was sparse.

The existing warning remains visible: verify part fitment by VIN and engine before purchase.

## Trigger and cost boundary

Only an explicit click on **Look up part numbers** or **Refresh part numbers** invokes Tavily and
DeepSeek. Order creation, order loading, page refresh, and browser-cache restoration invoke neither
provider. The existing cooldown remains in place.

Each click makes exactly one Tavily Basic Search request. Increase `max_results` from 10 to 20 while
keeping `search_depth: "basic"`, `include_answer: false`, United States country boosting, cleaned raw
text, and usage metadata. Do not enable Tavily automatic parameters, Advanced Search, Extract,
additional per-retailer searches, retries, or Google fallback.

The larger result count remains one Tavily credit but could increase DeepSeek input. Bound each
evidence block to 2,500 characters and the combined evidence passed to DeepSeek to 40,000
characters. Process evidence in descending Tavily relevance while preserving qualifying retailer
domain diversity before filling the remaining budget. The existing relevance threshold and HTTPS
validation remain mandatory.

## Request boundary and location privacy

The order page already has the order required to render Tech prep. Before calling the stateless
endpoint, the browser extracts a five-digit US ZIP from the order's service location. It sends only
that ZIP, never the original location string or street address. If no ZIP is available, omit the
field and use the fixed search location `San Jose, CA` on the server.

The bounded request contains only:

- vehicle year, make, and model;
- eligible Tech prep service IDs and names; and
- optional five-digit postal code.

It contains no customer identity, phone, email, street address, VIN, notes, order ID, price, or
other order data. Extend strict request validation to reject unknown fields and malformed postal
codes. The lookup route remains free of HMLS application-database imports and performs no
application-table reads or writes.

## One-pass retrieval and extraction

### Tavily query

Expand the deterministic combined query to request:

- engine-specific OEM and reputable aftermarket part numbers;
- compatible product pages and prices from AutoZone, O'Reilly Auto Parts, NAPA, Walmart, and
  Amazon; and
- relevance to the provided ZIP or the San Jose fallback.

Name the retailers in the query, but do not use `include_domains`, because restricting the search
to retailers would remove OEM catalogs and other authoritative fitment sources needed for the
primary part-number result.

### Evidence classification

Map qualifying Tavily results into provider-neutral evidence blocks as today, adding a server-side
retailer classification based solely on the normalized source hostname. Accept only the exact
domain or its subdomains:

- `autozone.com`;
- `oreillyauto.com`;
- `napaonline.com`;
- `walmart.com`; and
- `amazon.com`.

DeepSeek-provided retailer names never determine source identity. Non-retailer evidence remains
eligible for OEM and aftermarket reference grounding. Marketplace evidence remains ineligible as
the sole grounding for a primary part reference; it is accepted only for the separately validated
retailer-offer path.

### DeepSeek structured output

Extend the existing structured extraction with retailer-offer candidates grouped by service and
engine variant. A candidate may include product title, brand, product or part number, fitment note,
numeric price, and Amazon rating. It does not choose or create a URL.

The deterministic normalizer binds a retailer candidate to an allowlisted retailer evidence block
that contains its normalized product or part number. It derives retailer identity, source title,
and source URL from that evidence block. A direct product offer is accepted only when the evidence
also explicitly ties the product to the requested vehicle/engine or to an already accepted
compatible reference.

For a displayed price, parse currency amounts from the bound evidence and require the extracted
numeric value to match one of them. Construct the displayed currency string server-side. A missing
or unsupported price does not reject an otherwise grounded offer; it displays as **Price
unavailable**.

For Amazon, parse rating expressions from the same evidence block. Accept the direct Amazon offer
only when the grounded rating is at least 4.0. Reject Amazon offers with a lower or missing rating.
Amazon can still appear as a generic fallback search link.

## Ranking and fallback links

De-duplicate verified offers by normalized retailer, engine variant, and product or part number.
Rank accepted offers deterministically:

1. local-store retailers as one tier: AutoZone, O'Reilly, NAPA, and Walmart;
2. within that tier, known prices from lowest to highest, followed by missing prices;
3. Amazon after local-store retailers, with known prices from lowest to highest; and
4. retailer order (AutoZone, O'Reilly, NAPA, Walmart, Amazon), Tavily relevance, and normalized
   product title as stable tie-breakers.

Apply the maximum-two-per-retailer rule while selecting the first five offers.

Generate fallback search links in deterministic retailer order for retailers without a selected
offer until the section has five entries. Use only hardcoded, allowlisted HTTPS retailer search
endpoints and URL-encoded search text. Prefer an accepted OEM part number for the group, then an
accepted aftermarket number. If neither exists, use year, make, model, engine variant when known,
and service name. When no engine group is verified, create an **Engine not verified** service group
containing five retailer searches based on year, make, model, and service name. Never ask DeepSeek
to create a fallback URL.

A fallback link is intentionally less authoritative than a verified offer. Opening it delegates
store selection, local inventory, and final fitment confirmation to staff.

## Response shape and browser-local persistence

Keep primary references in `referencesByItemId`. Add a provider-neutral retailer result collection
grouped by service ID and engine variant. Each returned entry is explicitly either:

- `kind: "offer"`, containing grounded product metadata and a direct product URL; or
- `kind: "search"`, containing a deterministic retailer search URL and no product claims.

The web client validates the complete response before replacing its previous state. Upgrade the
browser cache to schema v3 and store the verified references and retailer entries together. Add the
postal code or the fixed San Jose fallback marker to the cache fingerprint. A vehicle, service, or
location change therefore invalidates old shopping results.

Results remain scoped to the current browser, shop, and order. They are not shared with another
browser, user, or device and disappear when site data is cleared. No database schema or order-item
metadata changes are permitted.

## Error handling and observability

- A successful Tavily response with no qualifying direct evidence returns `fallback_only` with five
  retailer searches in an **Engine not verified** service group.
- Valid part references with no valid retailer offers return partial success plus fallback search
  links.
- A failed refresh never clears the last successful result.
- Provider, timeout, authentication, quota, and structured-output failures remain sanitized.
- Unsafe domains, malformed URLs, unsupported prices, and unsupported ratings are discarded.
- Logs add verified-offer and fallback counts plus retailer-domain coverage. They retain provider,
  duration, Tavily credit, evidence, source, reference, and DeepSeek token metrics.
- Logs contain no query text, URLs, raw content, prompts, product output, customer data, ZIP, or
  credentials.

## Testing and acceptance

Automated tests cover:

- ZIP-only extraction and request validation, including proof that street address, order ID, and
  customer data are absent;
- the San Jose fallback when no ZIP is supplied;
- exactly one Tavily Basic Search with `max_results: 20`;
- per-block and total evidence bounds plus retailer-domain diversity;
- strict retailer hostname classification, including subdomains and lookalike rejection;
- preservation of the non-marketplace requirement for primary part references;
- literal product/part-number binding and vehicle/reference fitment grounding;
- literal price parsing and unsupported-price omission;
- Amazon rating acceptance at 4.0 or higher and rejection below 4.0 or when missing;
- deterministic ranking, de-duplication, five-total limit, and two-per-retailer limit;
- safe deterministic fallback URL generation and correct fallback labeling;
- fallback-only behavior with five retailer searches when no engine or direct product evidence can
  be verified;
- partial success and preservation of the last valid browser result after failure;
- cache-v3 parsing, location-fingerprint invalidation, and unsafe-URL rejection; and
- grouped **Where to buy** rendering with direct offers, prices, and fallback links.

Local acceptance uses the existing 2018 Toyota Camry Tech prep orders. One click must return the
existing engine-specific OEM references, show up to five retailer entries per variant, provide
fallback store searches when direct product evidence is sparse, open only allowlisted HTTPS links,
survive a page refresh, consume one Tavily credit, and leave the order database unchanged.

## Out of scope

- Inventory, pickup, delivery-date, shipping-time, or "available now" claims.
- Automatic purchasing, cart creation, store selection, or VIN-level fitment guarantees.
- More than one Tavily request per click, Tavily Advanced Search or Extract, retries, or scheduled
  refresh.
- Persisting search results in HMLS tables or sharing them across browsers.
- Moving the existing action to a different authorization surface.
- Changing order pricing, estimate totals, lifecycle state, or the database-backed repair-job
  search.
