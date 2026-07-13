# Tavily and DeepSeek part-number search implementation plan

**Goal:** Replace only the manual part-number lookup's Gemini runtime with one combined Tavily
Basic Search request and a DeepSeek structured extraction pass, while preserving its stateless API
and browser-local persistence.

**Design:** `docs/superpowers/specs/2026-07-13-tavily-deepseek-part-search-design.md`

## Task 1: Define and test provider-neutral Tavily evidence

**Files:**

- Modify `apps/agent/src/hmls/part-number-research.ts`
- Modify `apps/agent/src/hmls/part-number-research_test.ts`

1. Replace Gemini grounding types with bounded Tavily search request/result/usage types.
2. Build one deterministic query from the vehicle and every eligible service.
3. Convert qualifying Tavily results into HTTPS evidence blocks using a `0.5` score floor,
   `max_results: 10`, and a 4,000-character text cap per result.
4. Add pure tests proving multi-service input produces one bounded query containing no customer or
   order data, and malformed, unsafe, low-score, or overlong results are handled defensively.

## Task 2: Implement Tavily retrieval and DeepSeek extraction

**Files:**

- Modify `apps/agent/src/hmls/part-number-research.ts`
- Modify `apps/agent/src/hmls/part-number-research_test.ts`

1. Call Tavily's `/search` endpoint directly with `TAVILY_API_KEY`, Basic Search, US boost, raw text,
   no generated answer, usage reporting, and a 20-second abort timeout.
2. Sanitize missing-key, authentication, quota, rate-limit, timeout, malformed-response, and 5xx
   failures without logging credentials or response bodies.
3. Replace the Gemini extraction runner with `@ai-sdk/deepseek`, default
   `deepseek-v4-flash`, and optional `PART_LOOKUP_DEEPSEEK_MODEL` override.
4. Preserve strict structured output and deterministic literal-part-number binding; source titles
   and URLs continue to come only from accepted evidence.
5. Skip DeepSeek when Tavily yields no qualifying evidence. Return Tavily credit and DeepSeek token
   metrics without mixing the two units.
6. Keep Tavily and DeepSeek runners injectable so automated tests require no keys or network.

## Task 3: Make browser records provider-neutral and invalidate v1 cache

**Files:**

- Modify `apps/hmls-web/lib/part-reference-cache.ts`
- Modify `apps/hmls-web/lib/part-reference-cache.test.ts`
- Modify `apps/hmls-web/components/order/TechPrepCard.tsx`
- Modify `apps/hmls-web/components/order/TechPrepCard.test.ts`
- Modify `apps/gateway/src/routes/order-part-reference-lookup_test.ts`

1. Change online record source from `google_search` to `web_search` across the API, UI, fixtures,
   and validators.
2. Move the localStorage prefix and envelope to v2 so old Google-search records are ignored.
3. Preserve the current behavior that provider failure and `no_results` do not clear the last valid
   in-memory/browser result.
4. Extend tests for v1 invalidation, v2 round trips, source validation, grouped display, and the
   stateless route response.

## Task 4: Document and ship the isolated configuration

**Files:**

- Modify `CLAUDE.md`
- Modify `scripts/sync-deno-env.sh`

1. Document `TAVILY_API_KEY` as the manual part-number lookup credential and
   `PART_LOOKUP_DEEPSEEK_MODEL` as its optional model override.
2. Add both variables to the Infisical-to-Deno Deploy sync allowlist.
3. Leave the global `GOOGLE_API_KEY` requirement and every non-lookup Gemini path unchanged.
4. Verify the part-number research module contains no Google provider import or key access.

## Task 5: Verify automated and live behavior

1. Run focused agent, gateway route, cache, and Tech prep tests.
2. Run Deno check, lint, format check, agent tests, web typecheck/lint/tests, and relevant gateway
   suites.
3. Through Infisical, run a live 2018 Toyota Camry serpentine-belt lookup with the rotated Tavily
   key and existing DeepSeek key.
4. Confirm exactly one Tavily credit, source-backed engine/part results, linked HTTPS sources,
   browser refresh persistence, no Google invocation in this path, and no order/database mutation.
5. Push the stacked branch and open its pull request against
   `codex/tech-prep-part-number-lookup`; retarget it to `main` after PR #140 merges.
