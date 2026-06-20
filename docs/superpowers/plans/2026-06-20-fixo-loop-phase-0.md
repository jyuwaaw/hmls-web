# Fixo Loop — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the diagnostic data loop at N=1 (the dogfood shop) so the brain starts calibrating on real repairs — without coupling Fixo and HMLS beyond an HTTP boundary.

**Architecture:** Fixo = the brain (diagnostic + estimate engine). HMLS = a branded client. Phase 0 proves the loop on one shop before any API productization or multi-tenancy. The loop has two independent halves:
- **Loop 1 (order-side, zero Fixo coupling):** `order_intake.symptom_description` → `orders.confirmed_diagnosis`. This pair is the labeled ground truth. It needs (a) the field reliably filled, (b) an eval that scores the brain against it. **The field + write path already exist** — the gaps are capture-discipline and eval-wiring.
- **Loop 2 (cross-system, deferred to Slice 2):** the brain's *prediction* correlated to the outcome via a soft `prediction_id` over HTTP. Needs a blessed API contract first — see the REVIEW GATE.

**Tech Stack:** Deno (agent + gateway), Drizzle ORM (Supabase Postgres), Next.js/Bun (web), AI SDK v6 + Gemini 3 Flash (brain).

## Global Constraints

- Deno apps: `deno fmt` (double quotes, 2-space indent, 100-char width) + `deno lint`. Web: Biome (double quotes, 2-space). TS strict everywhere.
- Commits: conventional format. End commit messages with the Co-Authored-By trailer.
- **NEVER apply DDL/`db:push` via Infisical — `--env=dev` is the PROD database.** Schema changes ship as migration *files*; a human applies them deliberately.
- **No `git push` / no deploy without an explicit user ask.** Phase 0 lands on the branch only.
- Full local CI gate before any push: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build` (in `apps/hmls-web`) + `deno task check`.
- Autonomy line: build tooling/measurement and clearly-correct mechanics autonomously; defer anything that embeds a **product-behavior decision** (hard-block vs soft-nudge) or an **architectural contract** (the Fixo API shape) to user review.

---

### Task 1: Real-pair accuracy scoring in `fixo-eval` — STATUS: DONE (2026-06-20)

The measurement instrument for the moat. Adds a `--real` mode that pulls real
`(symptom → confirmed_diagnosis)` pairs from the DB, runs the brain on each
symptom, and scores the output against the confirmed truth. Pure tooling, no
product-behavior change, read-only DB, no prod writes. Safe to land autonomously.

**Files:**
- Modify: `apps/agent/src/scripts/fixo-eval.ts` (add `scoreDiagnosis`, `fetchRealPairs`, `--real`/`--limit` flags)
- Test: `apps/agent/src/scripts/fixo-eval_test.ts` (Deno test for the pure scorer)

**Interfaces:**
- Produces: `scoreDiagnosis(brainText: string, confirmedTruth: string): { score: number; matched: string[]; missed: string[] }` — term-overlap recall of the truth's significant terms. ponytail ceiling: crude string match; LLM-judge is the upgrade path.

- [x] **Step 1: Write the failing test** (`fixo-eval_test.ts`) — exact match → 1.0, partial → fraction, disjoint → 0, empty truth → 0.
- [x] **Step 2: Run it, verify it fails** (`scoreDiagnosis` not exported yet).
- [x] **Step 3: Implement `scoreDiagnosis` + `significantTerms`** (lowercase, split on non-alpha, drop stopwords + len<3, dedupe; score = matched/total).
- [x] **Step 4: Run `deno test apps/agent/src/scripts/fixo-eval_test.ts` → PASS.**
- [x] **Step 5: Add `fetchRealPairs(limit)` (lazy DB import) + `--real`/`--limit` branch in `main()`; update header usage comment.**
- [x] **Step 6: `deno task check` + `deno fmt` clean; commit.**

**Note:** `--real` returns 0 pairs until `confirmed_diagnosis` is actually being
filled (Task 2). The scorer is ready but starved until capture lands. Run it with:
`infisical run --env=dev -- deno run -A apps/agent/src/scripts/fixo-eval.ts --real`

---

### Task 2: Require/nudge `confirmed_diagnosis` at completion — STATUS: SPEC ONLY (needs a product decision)

Today `complete_job` (`in_progress → completed`) succeeds with an empty
`confirmed_diagnosis`. The field is editable but optional, so the loop starves.
This task makes capture reliable.

**DECISION REQUIRED (user):** hard-block vs soft-nudge.
- **(A) Soft-nudge (recommended):** web-only. Before `transitionStatus("completed")`, if `confirmedDiagnosis` is empty, show a confirm dialog ("Mark complete without recording what it actually was? This trains the diagnostic engine."). Non-blocking, reversible, zero gateway/contract risk. Mechanic can still skip.
- **(B) Hard-block:** gateway guard in `transition()` — reject `→ completed` when `confirmedDiagnosis` is empty (`Errors.badRequest`). Guarantees 100% fill but can wedge the completion flow and surprise the mechanic.

**Files (option A):**
- Modify: `apps/hmls-web/hooks/useOrderMutations.ts:35` (`transitionStatus`) or the `complete_job` action handler in the order detail BookingPanel/action bar.
- Test: web unit test for the guard predicate (empty diagnosis + target=completed → needs-confirm true).

**Steps (option A — TDD, write only after the decision is made):**
- [ ] **Step 1:** Write failing test for a pure `needsDiagnosisConfirm(order, targetStatus): boolean` helper (`true` iff `targetStatus === "completed" && !order.confirmedDiagnosis?.trim()`).
- [ ] **Step 2:** Run it, verify it fails.
- [ ] **Step 3:** Implement `needsDiagnosisConfirm` in a web lib.
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Wire the `complete_job` handler to gate on it (show dialog; proceed on confirm).
- [ ] **Step 6:** `bun run lint && bun run typecheck && bun run test && bun run build`; commit.

---

## Slice 2: Fixo brain as an internal API + `prediction_id` loop — REVIEW GATE

> **STOP — do not implement past this line without user sign-off on the contract.**
> The whole network play (other shops as Fixo-API clients) rests on this shape.
> Picking it wrong = expensive rework. This section is a *proposal* to review,
> not blessed tasks.

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

**Open decisions for review:**
1. Where does `predictionId` live on the order side? Proposed: nullable `orders.fixo_prediction_id` (text, NO FK — soft correlation, migration file only). Alternative: stash in `order_events.metadata`.
2. What triggers `POST /fixo/outcomes`? Proposed: fire when `confirmedDiagnosis` is saved on an order that carries a `fixo_prediction_id`.
3. Does HMLS's brain (`agent/src/hmls`) get fully replaced by these calls now, or incrementally (estimate first, diagnosis later)?
4. Internal transport: in-process function call vs real HTTP. Proposed: a typed in-process service module now, lifted to HTTP at productization (keeps the contract honest without standing up an API surface prematurely).

**After sign-off**, Slice 2 expands into TDD tasks: define the service contract → port the fixo tools behind it → swap HMLS callsites → add the `prediction_id` column migration → wire the outcome callback → eval the prediction-vs-truth join.

---

## Self-Review

- **Spec coverage:** Loop 1 (capture + eval) = Tasks 1–2. Loop 2 (prediction_id) = Slice 2 (gated). Matches the strategy memory's Phase 0.
- **Placeholder scan:** Task 1 is concrete + done. Task 2 steps are concrete for option A but gated on the A/B decision (intentional, flagged). Slice 2 is explicitly a proposal, not tasks (intentional, gated).
- **Type consistency:** `scoreDiagnosis` signature matches its test and the `--real` callsite. `needsDiagnosisConfirm` signature consistent across its steps.
