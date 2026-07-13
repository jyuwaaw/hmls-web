# Tech Prep Online Part Lookup — Implementation Plan

**Goal:** Add a durable, admin-triggered, grounded online lookup that saves up to three sourced
OEM/aftermarket part-number candidates per detected engine variant.

**Architecture:** A focused Gemini Google-Search service returns grounded structured candidates. A
new tenant-scoped admin endpoint validates those candidates and atomically changes only
`OrderItem.referenceParts`. The Tech prep card calls the endpoint directly and revalidates the saved
order.

**Design:** `docs/superpowers/specs/2026-07-12-tech-prep-online-part-lookup-design.md` (`9fa986f`).

## Constraints

- One grounded Gemini call per button click; page refreshes make no model call.
- No customer PII enters the search prompt.
- Up to three candidates per service and detected engine variant.
- Every persisted online candidate requires a grounded HTTPS source.
- Search metadata must not alter pricing, status, history, or revision number.
- Failed or empty refreshes keep existing references.

## Task 1: Online research service

**Files:**

- Create `apps/agent/src/hmls/part-number-research.ts`.
- Create `apps/agent/src/hmls/part-number-research_test.ts`.

**Steps:**

- Define bounded Zod schemas for raw service/engine/candidate results.
- Build a PII-free prompt from vehicle and eligible item IDs/names.
- Call Gemini with the provider's grounded Google Search tool.
- Parse JSON output and intersect candidate links with grounding sources.
- Normalize, de-duplicate, group, cap at three, and return partial/no-result summaries.
- Test prompt privacy and all validator/ranker rules with an injected model runner.

## Task 2: Metadata-only persistence and admin endpoint

**Files:**

- Extend `packages/shared/src/db/schema.ts`.
- Create `apps/agent/src/services/order-part-references.ts`.
- Create `apps/agent/src/services/order-part-references_test.ts`.
- Modify `apps/gateway/src/routes/orders.ts`.
- Add gateway route tests in the closest existing order-route test module.

**Steps:**

- Extend `PartReference` with online source, engine, type, fitment, source, and timestamp fields.
- Add a pure merge that replaces online references while preserving non-online references.
- Implement a shop-scoped optimistic JSON update guarded by the original items value.
- Add a 60-second in-process per-order lookup guard.
- Add `POST /orders/:id/reference-parts/lookup`, reusing admin auth and tenant scoping.
- Prove prices, subtotal, status/history, and revision remain unchanged.

## Task 3: Tech prep button and grouped results

**Files:**

- Modify `apps/hmls-web/lib/api-paths.ts`.
- Modify `apps/hmls-web/hooks/useOrderMutations.ts`.
- Modify `apps/hmls-web/components/order/TechPrepCard.tsx`.
- Extend `apps/hmls-web/components/order/TechPrepCard.test.ts`.
- Modify the admin order detail call site to provide revalidation.

**Steps:**

- Add lookup request state, toast handling, and SWR revalidation.
- Render Lookup/Refresh action in the Tech prep header.
- Group online results by service and engine variant, capped at three.
- Render type, brand, copy-friendly number, fitment note, source link, and verification warning.
- Preserve compact legacy RockAuto rendering.
- Test empty/loading/saved/grouped/error-safe behavior through pure helpers where possible.

## Task 4: Verification

- Run focused agent, service, gateway, and web tests.
- Run full Deno tests/check/lint/fmt and web tests/typecheck/lint/build.
- Start only the local HMLS API and web app with Infisical.
- Verify the authenticated order page, successful saved refresh, and narrow layout without leaving a
  temporary route or mutating production data.
