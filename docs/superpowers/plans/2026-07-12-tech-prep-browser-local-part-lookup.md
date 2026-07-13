# Browser-local grounded part-number lookup implementation plan

**Goal:** Replace the zero-source structured Google lookup with a grounded two-pass lookup whose
results persist only in the current browser and never access or mutate the HMLS orders database.

**Design:** `docs/superpowers/specs/2026-07-12-tech-prep-browser-local-part-lookup-design.md`

## Task 1: Build and test grounding evidence conversion

**Files:**

- Modify `apps/agent/src/hmls/part-number-research.ts`
- Modify `apps/agent/src/hmls/part-number-research_test.ts`

1. Define API-only `OnlinePartReference`, grounding metadata, evidence-block, and two-pass runner
   types without importing database `PartReference`.
2. Add a pure converter from Gemini grounding supports/chunks to numbered HTTPS evidence blocks.
3. Remove candidate-created URLs and citations from the extraction schema.
4. Add deterministic validation that locates the candidate part number in a non-marketplace evidence
   block, then de-duplicate and cap at three references per service/engine.
5. Add tests for malformed metadata, unsafe URLs, nonexistent evidence IDs, unsupported part-number
   claims, duplicate engine blocks, and the three-item cap.

## Task 2: Implement the two-pass Gemini runtime

**Files:**

- Modify `apps/agent/src/hmls/part-number-research.ts`

1. Run pass one with plain `generateText` and `google.tools.googleSearch({})`.
2. Read Google grounding metadata and construct evidence blocks.
3. Skip pass two when no usable evidence exists.
4. Run pass two without tools using `Output.object` and the extraction schema.
5. Return normalized display records plus bounded token/source/evidence metrics; log counts only.
6. Keep both model calls injectable so pure tests never require keys or network access.

## Task 3: Replace the database endpoint with a stateless endpoint

**Files:**

- Modify `apps/gateway/src/routes/order-part-reference-lookup.ts`
- Modify `apps/gateway/src/routes/order-part-reference-lookup_test.ts`
- Modify `apps/gateway/src/hmls-app.ts`
- Modify `apps/hmls-web/lib/api-paths.ts`
- Delete `apps/agent/src/services/order-part-references.ts`
- Delete `apps/agent/src/services/order-part-references_test.ts`
- Modify `apps/agent/deno.json`
- Revert the pending online-reference changes in `packages/shared/src/db/schema.ts`

1. Expose `POST /api/admin/part-references/lookup` behind admin authentication.
2. Validate a bounded vehicle/services body; do not accept an order ID or customer fields.
3. Remove all `dbAdmin`, order-table, merge, and optimistic-update code.
4. Return normalized references and lookup status directly.
5. Add auth, bad-payload, no-results, and success tests using an injectable research function where
   needed.
6. Add a static regression assertion that the route has no database import.

## Task 4: Add defensive browser-local persistence

**Files:**

- Add `apps/hmls-web/lib/part-reference-cache.ts`
- Add `apps/hmls-web/lib/part-reference-cache.test.ts`

1. Define a versioned cache envelope and an order/shop-scoped localStorage key.
2. Build a deterministic fingerprint from vehicle identity and eligible service IDs/names.
3. Validate cached display records, including source/type fields and HTTPS URLs.
4. Ignore malformed, stale, or unsupported cache data without throwing.
5. Test round trips, fingerprint invalidation, malformed JSON, unsafe links, and unavailable
   storage.

## Task 5: Wire the Tech prep cards to the stateless lookup

**Files:**

- Modify `apps/hmls-web/components/order/TechPrepCard.tsx`
- Modify `apps/hmls-web/components/order/TechPrepCard.test.ts`
- Modify `apps/hmls-web/app/(admin)/admin/orders/[id]/page.tsx`

1. Keep existing database-backed RockAuto collection separate from browser-local online records.
2. Load matching cached records after mount and show grouped engine cards with OEM/aftermarket
   labels and grounded source links.
3. Send only vehicle and eligible service data to the stateless endpoint.
4. On success, update component state and cache; on failure/no-results, retain the prior valid
   state.
5. Preserve the lookup/refresh/loading button states and VIN/engine verification warning.
6. Extend pure grouping and cache-integration tests.

## Task 6: Verify the repository and the live Camry case

1. Run focused Deno research/route tests and web cache/component tests.
2. Run Deno check, lint, format check, and the agent suite.
3. Run HMLS web typecheck, lint, and full tests.
4. Start only the HMLS API/web through Infisical.
5. On the 2018 Toyota Camry serpentine-belt order, confirm both supported engine groups, linked part
   numbers, refresh persistence, and no order update request/database write.
