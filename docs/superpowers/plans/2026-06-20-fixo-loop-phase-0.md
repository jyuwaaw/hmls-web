# Fixo Loop — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Close the diagnostic data loop at N=1 (the dogfood shop) so the brain starts calibrating
on real repairs — without coupling Fixo and HMLS beyond an HTTP boundary.

**Architecture:** Fixo = the brain (diagnostic + estimate engine). HMLS = a branded client. Phase 0
proves the loop on one shop before any API productization or multi-tenancy. The loop has two
independent halves:

- **Loop 1 (order-side, zero Fixo coupling):** `order_intake.symptom_description` →
  `orders.confirmed_diagnosis`. This pair is the labeled ground truth. It needs (a) the field
  reliably filled, (b) an eval that scores the brain against it. **The field + write path already
  exist** — the gaps are capture-discipline and eval-wiring.
- **Loop 2 (cross-system, deferred to Slice 2):** the brain's _prediction_ correlated to the outcome
  via a soft `prediction_id` over HTTP. Needs a blessed API contract first — see the REVIEW GATE.

**Tech Stack:** Deno (agent + gateway), Drizzle ORM (Supabase Postgres), Next.js/Bun (web), AI SDK
v6 + Gemini 3 Flash (brain).

## Global Constraints

- Deno apps: `deno fmt` (double quotes, 2-space indent, 100-char width) + `deno lint`. Web: Biome
  (double quotes, 2-space). TS strict everywhere.
- Commits: conventional format. End commit messages with the Co-Authored-By trailer.
- **NEVER apply DDL/`db:push` via Infisical — `--env=dev` is the PROD database.** Schema changes
  ship as migration _files_; a human applies them deliberately.
- **No `git push` / no deploy without an explicit user ask.** Phase 0 lands on the branch only.
- Full local CI gate before any push: `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run build` (in `apps/hmls-web`) + `deno task check`.
- Autonomy line: build tooling/measurement and clearly-correct mechanics autonomously; defer
  anything that embeds a **product-behavior decision** (hard-block vs soft-nudge) or an
  **architectural contract** (the Fixo API shape) to user review.

---

### Task 1: Real-pair accuracy scoring in `fixo-eval` — STATUS: DONE (2026-06-20)

The measurement instrument for the moat. Adds a `--real` mode that pulls real
`(symptom → confirmed_diagnosis)` pairs from the DB, runs the brain on each symptom, and scores the
output against the confirmed truth. Pure tooling, no product-behavior change, read-only DB, no prod
writes. Safe to land autonomously.

**Files:**

- Modify: `apps/agent/src/scripts/fixo-eval.ts` (add `scoreDiagnosis`, `fetchRealPairs`,
  `--real`/`--limit` flags)
- Test: `apps/agent/src/scripts/fixo-eval_test.ts` (Deno test for the pure scorer)

**Interfaces:**

- Produces:
  `scoreDiagnosis(brainText: string, confirmedTruth: string): { score: number; matched: string[]; missed: string[] }`
  — term-overlap recall of the truth's significant terms. ponytail ceiling: crude string match;
  LLM-judge is the upgrade path.

- [x] **Step 1: Write the failing test** (`fixo-eval_test.ts`) — exact match → 1.0, partial →
      fraction, disjoint → 0, empty truth → 0.
- [x] **Step 2: Run it, verify it fails** (`scoreDiagnosis` not exported yet).
- [x] **Step 3: Implement `scoreDiagnosis` + `significantTerms`** (lowercase, split on non-alpha,
      drop stopwords + len<3, dedupe; score = matched/total).
- [x] **Step 4: Run `deno test apps/agent/src/scripts/fixo-eval_test.ts` → PASS.**
- [x] **Step 5: Add `fetchRealPairs(limit)` (lazy DB import) + `--real`/`--limit` branch in
      `main()`; update header usage comment.**
- [x] **Step 6: `deno task check` + `deno fmt` clean; commit.**

**Note:** `--real` returns 0 pairs until `confirmed_diagnosis` is actually being filled (Task 2).
The scorer is ready but starved until capture lands. Run it with:
`infisical run --env=dev -- deno run -A apps/agent/src/scripts/fixo-eval.ts --real`

---

### Task 2: Capture `confirmed_diagnosis` at completion — STATUS: DONE (2026-06-20, option A: soft-nudge)

Today `complete_job` (`in_progress → completed`) succeeds with an empty `confirmed_diagnosis`, so
the loop starves. **Decision: soft-nudge (A).** Hard-block (B) was built first, then reverted at the
user's call ("don't hard-block"). The mechanic is prompted for the diagnosis inline at completion
but can always proceed; nothing is enforced server-side.

**Files:**

- `packages/shared/src/order/status.ts` (+ `status_test.ts`) — pure
  `completionMissingDiagnosis(to, confirmedDiagnosis)` predicate (kept; now web-only).
- `apps/hmls-web/lib/order-actions.ts` (+ `order-actions.test.ts`) — `complete_job.invoke` prompts
  via the existing `askReason` dialog when the diagnosis is missing, saves the entry if given, then
  completes; `null` (backed out) aborts. `saveConfirmedDiagnosis` added to `ActionContext`.
- Reverted: the `transition()` guard + `diagnosis_required` error code + its HTTP/tool mappers
  (server no longer blocks).

- [x] TDD `completionMissingDiagnosis` (shared, 3 cases).
- [x] `complete_job` soft-nudge (web, 4 cases: present→complete; missing+text→save+complete;
      missing+blank→complete; missing+cancel→abort).
- [x] Verified: `deno task check` / lint / fmt + shared tests; web `bun test` + `typecheck` + biome.
      Committed.

**UX:** mechanic clicks Complete → if no diagnosis, a titled text prompt ("What did it turn out to
be?") appears; type it (saved) or leave blank (skipped); either way the order completes. Captures at
the highest-leverage moment without wedging anyone.

---

## Slice 2: Fixo brain as an in-process service + `prediction_id` loop — CONTRACT LOCKED (2026-06-20)

> Contract blessed by the user. Full replace; **in-process function module (not HTTP)** for Phase 0.
> The contract lives in code at `apps/agent/src/fixo/brain-service.ts`. The route shapes below are
> the transport-agnostic contract — Phase 0 calls them as functions; Phase 2 lifts them behind HTTP
> for external shops (callsites unchanged).

**Proposed contract (internal first — no auth/versioning/rate-limits yet):**

```
POST /fixo/diagnose
  body: { vehicle: {year,make,model}, symptom: string, dtcs?: string[], photoUrls?: string[] }
  → { predictionId: string, candidateSystems: [...], rootCause?: string, tests?: [...] }

POST /fixo/estimate
  body: { predictionId?: string, vehicle, diagnosis, shopPricing?: {...} }
  → { predictionId: string, items: OrderItem[], subtotalCents, priceRangeLow/HighCents }

POST /fixo/outcomes            # the back-seam / loop closer
  body: { predictionId: string, confirmedDiagnosis: string, actualCostCents?: number }
  → { ok: true }
```

**Locked decisions:**

1. `predictionId` placement → nullable `orders.fixo_prediction_id` (text, **NO FK** — soft
   correlation). Migration FILE only; user applies.
2. Outcome trigger → when `confirmed_diagnosis` is saved on an order carrying `fixo_prediction_id`,
   fire `recordOutcome`.
3. HMLS brain → **FULL replace**: `agent/src/hmls` diagnosis + estimate route through
   `BrainService`.
4. Transport → **in-process function module now**; HTTP-liftable later (serializable DTOs +
   `predictionId`). No HTTP infra until external shops (Phase 2). Why: same deploy today (a hop buys
   no isolation); chat hot-path reliability; the contract carries the decoupling, not the transport,
   so the lift is a swap not a rewrite.

**Tasks (TDD, ordered):**

- [x] **2.1 Contract module** — `brain-service.ts`: DTOs + `BrainService` interface +
      `newPredictionId` (tested). DONE.
- [x] **2.2 Prediction store** — DONE. `fixo_predictions` table + nullable
      `orders.fixo_prediction_id` in `schema.ts`; hand-written
      `migrations/0027_fixo_predictions.sql` (db:generate is unsafe here — journal out of sync per
      0026; NOT applied, apply via prod path). deno check + web typecheck clean.
- [x] **2.3 In-process impl** (`fixo-brain.ts`) — DONE:
  - [x] `diagnose` — rule-based candidate systems via the exported `isolateSystems` core; writes a
        `fixo_predictions` row keyed by a fresh `predictionId`; stores raw `dtcs`. (DTC→system
        mapping via `lookupObdCode` + LLM `rootCause`/`tests` synthesis = later enhancement.)
  - [x] `recordOutcome` — idempotent UPDATE of the prediction row by `predictionId`; logs (never
        throws) on a missing row.
  - [x] unit test for the `isolateSystems` core (was untested).
  - [x] `recordEstimate` + assembly — the OLP pricing engine is ALREADY shared
        (`skills/estimate/pricing.ts`, used by HMLS `create_order` + Fixo), so estimates are NOT
        re-priced through the brain (rerouting the untested central order tool = risk, no functional
        gain). Instead the brain RECORDS the priced estimate: `recordEstimate` attaches
        `predicted_estimate` to the prediction; `create_order` calls it best-effort after diagnose.
        Contract revised (`estimate` → `recordEstimate`); full
        `brain: BrainService = { diagnose, recordEstimate, recordOutcome }` assembled.
- [~] **2.4 HMLS integration** — PARTIAL: `create_order` (INSERT path) runs `diagnose` when a
  symptom is present and stamps `fixo_prediction_id` on the new order (best-effort; the column is
  referenced only when set, so it degrades safely pre-migration). **This + 2.5 makes the loop live
  end-to-end**: symptom → prediction → order → confirmed_diagnosis → `recordOutcome`. Still pending:
  the "full replace" of HMLS's _estimate_ through `BrainService.estimate` (tied to 2.3 estimate).
- [x] **2.5 Outcome callback** — DONE. Gateway orders PATCH fires `recordOutcome` after a
      `confirmed_diagnosis` write when the order carries `fixo_prediction_id` (actualCost =
      paidAmount ?? subtotal). Fire-and-forget (`.catch` logs), never blocks the save. Added
      `@hmls/agent/fixo-brain` export. No-op until 2.4 stamps `prediction_id`.
- [ ] **2.6 Eval join** — extend `fixo-eval --real` to score the brain's stored prediction against
      the confirmed outcome via the `predictionId` join (not just a fresh re-run).

---

## Self-Review

- **Spec coverage:** Loop 1 (capture + eval) = Tasks 1–2. Loop 2 (prediction_id) = Slice 2 (gated).
  Matches the strategy memory's Phase 0.
- **Placeholder scan:** Task 1 is concrete + done. Task 2 steps are concrete for option A but gated
  on the A/B decision (intentional, flagged). Slice 2 is explicitly a proposal, not tasks
  (intentional, gated).
- **Type consistency:** `scoreDiagnosis` signature matches its test and the `--real` callsite.
  `needsDiagnosisConfirm` signature consistent across its steps.
