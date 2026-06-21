# Fixo Structured Diagnose (v1, in-process) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Fixo brain's diagnosis into a rich, structured, single-shot result (not
free-text), exposed in-process and via the existing `/v1/diagnose` REST endpoint, and feed the
calibration loop with the expert diagnosis instead of the shallow rule layer.

**Architecture:** Build `diagnoseStructured()` on the already-proven single-shot agent run
(`runFixoOnce` pattern) by adding an `emit_diagnosis` capture tool whose Zod schema IS the
structured-output contract. The agent reasons (using its existing tools), then calls
`emit_diagnosis` once with the final structured diagnosis; we drain the stream and return those
args. Stateless — no `fixo_sessions` row. Swap `/v1/diagnose` to return it, and point
`BrainService.diagnose` at it so the prediction row records the expert diagnosis.

**Tech Stack:** Deno, AI SDK v6 (`ai`), `@ai-sdk/google` (Gemini 3 Flash), Zod, Drizzle, Hono
(gateway). Tests: `deno test`.

## Global Constraints

- Migrations are HAND-WRITTEN. `db:push` / `db:generate` are UNSAFE (journal drifted). If a column
  is needed, write `apps/agent/migrations/NNNN_*.sql` with `IF NOT EXISTS`; do NOT apply it (the
  user applies prod migrations).
- In-process only this plan. NO MCP server, NO new `@modelcontextprotocol/sdk` dependency, NO HTTP
  transport between HMLS and Fixo. (Deferred to a later plan.)
- Stateless single-shot. Do NOT create `fixo_sessions` rows; do NOT use `update_diagnostic_state`
  (it requires a live session). Structured output comes from the `emit_diagnosis` tool, not from
  `diagnostic_state`.
- Deno tests must NOT import the heavy agent graph at module-load (it pulls react-pdf and crashes
  the test loader). Keep pure logic (schemas, prompt builders) in separate files that tests import
  directly — mirror the existing `run-once-prompt.ts` split.
- Code style: `deno fmt` (double quotes, 2-space, 100 cols) + `deno lint`. Conventional commits, end
  with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## File structure

- **Create** `apps/agent/src/fixo/diagnosis-schema.ts` — pure Zod schema
  `structuredDiagnosisSchema` + `StructuredDiagnosis` type. No heavy imports (test-safe).
- **Create** `apps/agent/src/fixo/diagnosis-schema_test.ts` — schema parse tests.
- **Create** `apps/agent/src/fixo/tools/emit-diagnosis.ts` — the `emitDiagnosisTool` (schema = the
  structured schema; `execute` echoes its input — a capture tool).
- **Modify** `apps/agent/src/fixo/agent.ts` — add `emitDiagnosisTool` to the agent's tool list.
- **Create** `apps/agent/src/fixo/diagnose-structured.ts` — `diagnoseStructured(input)` runs the
  agent single-shot, drains the stream, returns the captured `StructuredDiagnosis`.
- **Modify** `apps/agent/src/fixo/run-once-prompt.ts` — add `buildStructuredDiagnosePrompt(input)`
  (instructs the agent to finish by calling `emit_diagnosis`).
- **Create** `apps/agent/src/fixo/diagnose-structured_test.ts` — prompt-builder + stream-drain unit
  tests (no live LLM).
- **Modify** `apps/agent/src/fixo/fixo-brain.ts` — `diagnose` runs `diagnoseStructured`, stores the
  rich result in `fixo_predictions.predicted_diagnosis`, returns the enriched `DiagnoseResult`.
- **Modify** `apps/gateway/src/routes/fixo/api.ts` — `/v1/diagnose` returns the structured result.
- **Modify** `apps/agent/src/common/tools/order.ts` — keep `create_order` non-blocking (mint id
  sync, run the expert diagnosis fire-and-forget).

---

### Task 1: Structured diagnosis schema + `emit_diagnosis` tool

**Files:**

- Create: `apps/agent/src/fixo/diagnosis-schema.ts`
- Test: `apps/agent/src/fixo/diagnosis-schema_test.ts`
- Create: `apps/agent/src/fixo/tools/emit-diagnosis.ts`

**Interfaces:**

- Produces: `structuredDiagnosisSchema` (Zod), `StructuredDiagnosis` (type), `emitDiagnosisTool` (a
  `LegacyTool`: `{ name, description, schema, execute }`).

- [ ] **Step 1: Write the failing schema test**

```ts
// diagnosis-schema_test.ts
import { assertEquals } from "jsr:@std/assert";
import { structuredDiagnosisSchema } from "./diagnosis-schema.ts";

Deno.test("structuredDiagnosisSchema — accepts a full diagnosis", () => {
  const parsed = structuredDiagnosisSchema.parse({
    candidate_systems: [{ system: "brakes", confidence: 3, reasons: ["grinding + pulsation"] }],
    likely_root_cause: "worn front pads + warped rotors",
    recommended_tests: ["inspect pad thickness", "measure rotor runout"],
    safety_flags: ["increased stopping distance — avoid high speed"],
    to_confirm: ["ABS light on?", "sudden vs gradual?"],
    narrative: "Grinding + pedal pulsation point to front brakes.",
  });
  assertEquals(parsed.candidate_systems[0].system, "brakes");
});

Deno.test("structuredDiagnosisSchema — minimal (only required fields)", () => {
  const parsed = structuredDiagnosisSchema.parse({
    candidate_systems: [],
    recommended_tests: [],
    safety_flags: [],
    to_confirm: [],
    narrative: "Not enough info yet.",
  });
  assertEquals(parsed.likely_root_cause, undefined);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `deno test apps/agent/src/fixo/diagnosis-schema_test.ts` Expected: FAIL —
`Module not found "./diagnosis-schema.ts"`.

- [ ] **Step 3: Write the schema**

```ts
// diagnosis-schema.ts — pure; no heavy imports so tests load it directly.
import { z } from "zod";

export const structuredDiagnosisSchema = z.object({
  candidate_systems: z.array(z.object({
    system: z.string().describe("e.g. 'brakes', 'fuel', 'ignition', 'cooling'"),
    confidence: z.number().int().min(0).max(3).describe("0=ruled-out,1=low,2=medium,3=high"),
    reasons: z.array(z.string()),
  })).describe("Ranked suspect systems."),
  likely_root_cause: z.string().optional()
    .describe("Single most-likely cause — set ONLY when evidence supports one answer."),
  recommended_tests: z.array(z.string()).describe("Pinpoint tests to confirm, cheapest-first."),
  safety_flags: z.array(z.string()).describe("Anything unsafe to drive with. Empty if none."),
  to_confirm: z.array(z.string())
    .describe("Questions the shop should confirm with the owner / on-site to narrow it down."),
  narrative: z.string().describe("Short plain-language summary for the shop."),
});

export type StructuredDiagnosis = z.infer<typeof structuredDiagnosisSchema>;
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `deno test apps/agent/src/fixo/diagnosis-schema_test.ts` Expected: PASS (2 tests).

- [ ] **Step 5: Write the `emit_diagnosis` tool**

```ts
// tools/emit-diagnosis.ts
import { structuredDiagnosisSchema } from "../diagnosis-schema.ts";

// A capture tool: the agent calls it ONCE with its final structured diagnosis.
// execute just echoes — diagnose-structured.ts reads the args off the stream.
export const emitDiagnosisTool = {
  name: "emit_diagnosis",
  description: "Call EXACTLY ONCE as your final action, with your complete structured diagnosis. " +
    "After calling it, stop. Do not ask the user anything.",
  schema: structuredDiagnosisSchema,
  // deno-lint-ignore no-explicit-any
  execute: (input: any) => input,
};
```

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/fixo/diagnosis-schema.ts apps/agent/src/fixo/diagnosis-schema_test.ts apps/agent/src/fixo/tools/emit-diagnosis.ts
git commit -m "feat(fixo): structured diagnosis schema + emit_diagnosis capture tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Register `emit_diagnosis` on the agent + structured prompt

**Files:**

- Modify: `apps/agent/src/fixo/agent.ts` (the `allTools` array — see Explore notes; it lists the
  Fixo tools)
- Modify: `apps/agent/src/fixo/run-once-prompt.ts`
- Test: `apps/agent/src/fixo/diagnose-structured_test.ts` (prompt part)

**Interfaces:**

- Consumes: `emitDiagnosisTool` (Task 1), existing `buildDiagnosePrompt` / `DiagnoseOnceInput`
  (run-once-prompt.ts).
- Produces: `buildStructuredDiagnosePrompt(input: DiagnoseOnceInput): string`.

- [ ] **Step 1: Write the failing prompt test**

```ts
// diagnose-structured_test.ts
import { assert } from "jsr:@std/assert";
import { buildStructuredDiagnosePrompt } from "./run-once-prompt.ts";

Deno.test("buildStructuredDiagnosePrompt — instructs emit_diagnosis + no questions", () => {
  const p = buildStructuredDiagnosePrompt({
    vehicle: { year: 2018, make: "Honda", model: "Civic" },
    symptom: "grinding when braking",
  });
  assert(p.includes("Honda"));
  assert(p.includes("emit_diagnosis"));
  assert(/do not ask|don't ask/i.test(p));
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `deno test apps/agent/src/fixo/diagnose-structured_test.ts` Expected: FAIL —
`buildStructuredDiagnosePrompt` not exported.

- [ ] **Step 3: Add `buildStructuredDiagnosePrompt` to run-once-prompt.ts**

```ts
// append to run-once-prompt.ts (keeps the existing buildDiagnosePrompt)
export function buildStructuredDiagnosePrompt(input: DiagnoseOnceInput): string {
  const v = `${input.vehicle.year} ${input.vehicle.make} ${input.vehicle.model}`.trim();
  const dtcs = input.dtcs?.length ? ` OBD codes present: ${input.dtcs.join(", ")}.` : "";
  return `Vehicle: ${v}. Customer symptom: ${input.symptom}.${dtcs}\n\n` +
    `Diagnose this as an expert mechanic. Use your tools to reason. This is a ONE-SHOT ` +
    `request — you will NOT get a reply, so do NOT ask the user questions; instead put any ` +
    `clarifying questions in the diagnosis's "to_confirm" field. Finish by calling ` +
    `emit_diagnosis exactly once with your complete structured diagnosis.`;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `deno test apps/agent/src/fixo/diagnose-structured_test.ts` Expected: PASS.

- [ ] **Step 5: Register the tool on the agent**

In `apps/agent/src/fixo/agent.ts`, import `emitDiagnosisTool` and add it to the `allTools` array
(alongside `updateDiagnosticStateTool`, `isolateSystemsTool`, etc.):

```ts
import { emitDiagnosisTool } from "./tools/emit-diagnosis.ts";
// ...inside allTools: [...existing, isolateSystemsTool, planPinpointTestsTool, emitDiagnosisTool]
```

(Harmless in chat — the agent only calls it when the prompt asks.)

- [ ] **Step 6: Verify the agent module still type-checks**

Run: `deno check apps/agent/src/mod.ts` Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/fixo/agent.ts apps/agent/src/fixo/run-once-prompt.ts apps/agent/src/fixo/diagnose-structured_test.ts
git commit -m "feat(fixo): register emit_diagnosis tool + structured single-shot prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `diagnoseStructured()` — run single-shot, capture the structured result

**Files:**

- Create: `apps/agent/src/fixo/diagnose-structured.ts`
- Test: `apps/agent/src/fixo/diagnose-structured_test.ts` (add the drain test)

**Interfaces:**

- Consumes: `runFixoAgent` (agent.ts), `buildStructuredDiagnosePrompt` (Task 2),
  `structuredDiagnosisSchema` / `StructuredDiagnosis` (Task 1), `DiagnoseOnceInput`
  (run-once-prompt.ts).
- Produces:
  `async function diagnoseStructured(input: DiagnoseOnceInput): Promise<StructuredDiagnosis>` and a
  pure helper
  `pickEmitDiagnosis(parts: {type:string; toolName?:string; output?:unknown}[]): unknown` (the
  stream-scan, unit-testable without an LLM).

- [ ] **Step 1: Write the failing drain-helper test**

```ts
// add to diagnose-structured_test.ts
import { pickEmitDiagnosis } from "./diagnose-structured.ts";

Deno.test("pickEmitDiagnosis — returns the emit_diagnosis tool output", () => {
  const out = pickEmitDiagnosis([
    { type: "tool-result", toolName: "isolate_systems", output: { candidates: [] } },
    {
      type: "tool-result",
      toolName: "emit_diagnosis",
      output: { narrative: "x", candidate_systems: [] },
    },
  ]);
  assertEquals((out as { narrative: string }).narrative, "x");
});

Deno.test("pickEmitDiagnosis — null when never emitted", () => {
  assertEquals(pickEmitDiagnosis([{ type: "tool-result", toolName: "isolate_systems" }]), null);
});
```

(Add `import { assertEquals } from "jsr:@std/assert";` at top if not present.)

- [ ] **Step 2: Run it, confirm it fails**

Run: `deno test apps/agent/src/fixo/diagnose-structured_test.ts` Expected: FAIL —
`pickEmitDiagnosis` not exported.

- [ ] **Step 3: Implement `diagnose-structured.ts`**

```ts
// diagnose-structured.ts
import type { ModelMessage } from "ai";
import { runFixoAgent } from "./agent.ts";
import { buildStructuredDiagnosePrompt } from "./run-once-prompt.ts";
import type { DiagnoseOnceInput } from "./run-once-prompt.ts";
import { type StructuredDiagnosis, structuredDiagnosisSchema } from "./diagnosis-schema.ts";

// Pure: scan drained stream parts for the emit_diagnosis tool output. Last one wins.
export function pickEmitDiagnosis(
  parts: { type: string; toolName?: string; output?: unknown; result?: unknown }[],
): unknown {
  let found: unknown = null;
  for (const p of parts) {
    if (p.type === "tool-result" && p.toolName === "emit_diagnosis") {
      found = p.output ?? p.result ?? null;
    }
  }
  return found;
}

export async function diagnoseStructured(input: DiagnoseOnceInput): Promise<StructuredDiagnosis> {
  const messages: ModelMessage[] = [
    { role: "user", content: buildStructuredDiagnosePrompt(input) },
  ];
  const result = runFixoAgent({ messages });

  const parts: { type: string; toolName?: string; output?: unknown }[] = [];
  for await (const part of result.fullStream) {
    // deno-lint-ignore no-explicit-any
    const p = part as any;
    if (p.type === "tool-result") {
      parts.push({ type: p.type, toolName: p.toolName, output: p.output });
    }
  }
  await result.text; // ensure the run settled

  const raw = pickEmitDiagnosis(parts);
  if (raw === null) {
    // Agent didn't emit — degrade to a minimal valid diagnosis rather than throw.
    return structuredDiagnosisSchema.parse({
      candidate_systems: [],
      recommended_tests: [],
      safety_flags: [],
      to_confirm: ["Need more detail — re-run with a fuller symptom description."],
      narrative: "Could not produce a structured diagnosis from the given input.",
    });
  }
  return structuredDiagnosisSchema.parse(raw); // validates the agent's args
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `deno test apps/agent/src/fixo/diagnose-structured_test.ts` Expected: PASS (drain-helper +
prompt tests).

- [ ] **Step 5: Live smoke (manual, not a unit test)**

Run (via Infisical for `GOOGLE_API_KEY`):
`infisical run --env=dev -- deno eval 'import { diagnoseStructured } from "./apps/agent/src/fixo/diagnose-structured.ts"; console.log(JSON.stringify(await diagnoseStructured({ vehicle: { year: 2018, make: "Honda", model: "Civic" }, symptom: "grinding when braking, pedal vibrates" }), null, 2)); Deno.exit(0);'`
Expected: a JSON object with `candidate_systems` including brakes, non-empty `recommended_tests`,
`narrative`. (Confirms the agent reliably calls `emit_diagnosis`.)

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/fixo/diagnose-structured.ts apps/agent/src/fixo/diagnose-structured_test.ts
git commit -m "feat(fixo): diagnoseStructured — single-shot agent run captured to a typed diagnosis

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Swap `/v1/diagnose` to return the structured diagnosis

**Files:**

- Modify: `apps/gateway/src/routes/fixo/api.ts`

**Interfaces:**

- Consumes: `diagnoseStructured` (Task 3). Replaces the `runFixoOnce` call.

- [ ] **Step 1: Update the route**

Replace the handler body (currently
`const result = await runFixoOnce(body); return c.json(result);`) with:

```ts
import { diagnoseStructured } from "@hmls/agent"; // add export in mod.ts (Step 2)
// ...
fixoApi.post("/diagnose", zValidator("json", diagnoseInput), async (c) => {
  const body = c.req.valid("json");
  const diagnosis = await diagnoseStructured(body);
  return c.json({ diagnosis });
});
```

- [ ] **Step 2: Export `diagnoseStructured` from the agent package**

In `apps/agent/src/mod.ts`, add:

```ts
export { diagnoseStructured } from "./fixo/diagnose-structured.ts";
export { type StructuredDiagnosis } from "./fixo/diagnosis-schema.ts";
```

- [ ] **Step 3: Type-check the gateway**

Run: `deno check apps/gateway/src/index.ts` Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/routes/fixo/api.ts apps/agent/src/mod.ts
git commit -m "feat(fixo-api): /v1/diagnose returns the structured diagnosis (was free-text)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Feed the loop with the expert diagnosis (BrainService.diagnose), non-blocking in create_order

**Files:**

- Modify: `apps/agent/src/fixo/fixo-brain.ts`
- Modify: `apps/agent/src/common/tools/order.ts:592-612` (the diagnose call in the INSERT path)

**Interfaces:**

- Consumes: `diagnoseStructured` (Task 3), existing `newPredictionId`, `schema.fixoPredictions`,
  existing `DiagnoseResult`.
- Produces: `openPrediction(req: DiagnoseRequest): Promise<string>` (sync-cheap: mint id + insert
  row, no LLM) and keeps `diagnose` for full structured runs.

**Why split:** `create_order` awaits `diagnose` today. Making `diagnose` run the agent (~5s) would
block order creation. So `create_order` calls the cheap `openPrediction` (gets the id, stamps the
order), then fires the expert diagnosis in the background to fill the row. Direct callers
(API/tests) still use `diagnose` for the full result.

- [ ] **Step 1: Write the failing test for openPrediction**

```ts
// fixo-brain_test.ts (new) — pure-ish: only asserts the id shape + that it doesn't run the agent.
import { assert } from "jsr:@std/assert";
import { newPredictionId } from "./brain-service.ts";
Deno.test("newPredictionId — pred_ prefixed uuid", () => {
  assert(/^pred_[0-9a-f-]{36}$/.test(newPredictionId()));
});
```

(DB-touching `openPrediction` is covered by the live smoke in Step 4, not a unit test — no DB in
`deno test`.)

- [ ] **Step 2: Run it, confirm it passes (guards the id contract)**

Run: `deno test apps/agent/src/fixo/fixo-brain_test.ts` Expected: PASS.

- [ ] **Step 3: Add `openPrediction` + route `diagnose` through `diagnoseStructured`**

In `fixo-brain.ts`:

```ts
import { diagnoseStructured } from "./diagnose-structured.ts";
import type { DiagnoseRequest } from "./brain-service.ts";

// Cheap, synchronous-ish: mint id + insert the prediction row WITHOUT running the
// agent. For the create_order hot path — fill predicted_diagnosis async after.
export async function openPrediction(req: DiagnoseRequest): Promise<string> {
  const predictionId = newPredictionId();
  await db.insert(schema.fixoPredictions).values({
    id: predictionId,
    vehicleInfo: req.vehicle,
    symptom: req.symptom,
    dtcs: req.dtcs ?? null,
    predictedDiagnosis: null,
  });
  return predictionId;
}

// Fill an existing prediction row with the expert structured diagnosis.
export async function fillPrediction(predictionId: string, req: DiagnoseRequest): Promise<void> {
  const structured = await diagnoseStructured({
    vehicle: req.vehicle,
    symptom: req.symptom,
    dtcs: req.dtcs,
  });
  await db.update(schema.fixoPredictions)
    .set({ predictedDiagnosis: structured })
    .where(eq(schema.fixoPredictions.id, predictionId));
}
```

Update `diagnose` to use the expert path (one awaited call, for API/direct callers):

```ts
export const diagnose: BrainService["diagnose"] = async (req) => {
  const predictionId = await openPrediction(req);
  const structured = await diagnoseStructured(req);
  await db.update(schema.fixoPredictions)
    .set({ predictedDiagnosis: structured })
    .where(eq(schema.fixoPredictions.id, predictionId));
  return {
    predictionId,
    candidateSystems: structured.candidate_systems as DiagnoseResult["candidateSystems"],
    rootCause: structured.likely_root_cause,
    tests: structured.recommended_tests,
  };
};
```

- [ ] **Step 4: Make create_order non-blocking**

In `order.ts` (the INSERT block around lines 599-612), replace the awaited `diagnose(...)` with the
cheap open + a fire-and-forget fill:

```ts
let fixoPredictionId: string | null = null;
if (symptomDescription) {
  try {
    fixoPredictionId = await openPrediction({ vehicle: vehicleInfo, symptom: symptomDescription });
    // Fire-and-forget: the expert diagnosis (~5s agent run) must not block order create.
    // ponytail: if a worker/queue ever exists, move this there; for now a detached promise is fine.
    void fillPrediction(fixoPredictionId, { vehicle: vehicleInfo, symptom: symptomDescription })
      .catch((err) => console.error("fillPrediction failed:", String(err)));
  } catch (err) {
    console.error("openPrediction failed during order create:", String(err));
  }
}
// ...stamp fixoPredictionId on the order insert exactly as today...
```

Update the import in `order.ts:28` from `{ diagnose, recordEstimate }` to
`{ openPrediction, fillPrediction, recordEstimate }`.

- [ ] **Step 5: Type-check + run the full Deno suite**

Run: `deno task check && deno test apps/agent/src/fixo/` Expected: check clean; fixo tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/fixo/fixo-brain.ts apps/agent/src/fixo/fixo-brain_test.ts apps/agent/src/common/tools/order.ts
git commit -m "feat(fixo): loop records the expert structured diagnosis; create_order stays non-blocking

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred (explicitly NOT in this plan — future plans)

- **Multi-turn `observe` stepping** (narrow a diagnosis across calls). Needs either client-carried
  context or a transient per-ticket session; the real diagnostic state machine
  (`update_diagnostic_state`) is welded to `fixo_sessions`. v1 is single-shot; `to_confirm[]`
  carries the questions instead of a second turn.
- **MCP server + transport** (`@modelcontextprotocol/sdk`, Streamable HTTP, Hono mount). The whole
  point of `brain-service.ts`'s serializable DTOs is that this is a later transport swap. Needs a
  Deno+Hono MCP spike first.
- **HMLS agent as a tool consumer** (giving `runHmlsAgent` a `fixo_diagnose` tool). AI SDK
  `ai@6.0.169` has no MCP client; in-process is possible later but out of scope here.
- **`estimate` / `record_outcome` already work** (in-process, via the existing OLP engine +
  `fixo_predictions`); no change this plan beyond what Task 5 records.

## Risks

- **`emit_diagnosis` reliability:** the agent must call it as the final step. Mitigated by the
  prompt (Task 2) + the degrade-to-minimal fallback (Task 3) + the live smoke (Task 3 Step 5). If
  the model skips it often, add a second `generateObject` coercion pass — but only if the smoke
  shows it's needed.
- **`predicted_diagnosis` column type:** `fixo_predictions.predicted_diagnosis` is already `jsonb`
  (today stores `{ candidateSystems }`); storing the richer `StructuredDiagnosis` needs NO
  migration. Verify the column is nullable for `openPrediction` (it inserts `null`); if NOT, write a
  hand migration to drop the not-null / default `{}`.
