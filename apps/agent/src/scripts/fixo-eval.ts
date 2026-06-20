// apps/agent/src/scripts/fixo-eval.ts
//
// Fixo capability harness — runs scripted diagnostic scenarios straight through
// `runFixoAgent` (the real engine, real OLP data) and prints the full tool +
// reasoning trace, then runs light per-scenario checks.
//
// It calls the agent with NO `userId` / `fixoSessionId`, which makes the run
// read-only:
//   - create_estimate          → returns full pricing WITHOUT writing fixo_estimates
//   - update_diagnostic_state  → no-ops gracefully ("no_session")
//   - lookupObdCode / labor / parts lookups → read OLP + obd tables (need DATABASE_URL)
//   - isolate_systems / plan_pinpoint_tests → pure static rules
//
// So nothing is written to the DB and no Fixo credits are spent (this is the
// raw Gemini engine, billed to GOOGLE_API_KEY directly — not the credit ledger).
//
// Run (infisical injects GOOGLE_API_KEY + DATABASE_URL):
//   infisical run --env=dev -- deno run -A apps/agent/src/scripts/fixo-eval.ts
//   ... --filter brake          # only scenarios whose name includes "brake"
//   ... --list                  # list scenarios and exit
//   ... --json                  # emit full structured results as JSON at the end
//   ... --real [--limit N]      # score the brain against real (symptom →
//                               #   confirmed_diagnosis) pairs pulled from the DB
//
// The --real mode is the A-phase shadow-accuracy eval: it pulls real
// (symptom → confirmed_diagnosis) pairs, runs the brain on each symptom, and
// scores the output against the confirmed truth (see diagnosis-score.ts).
// Returns 0 pairs until mechanics actually fill confirmed_diagnosis.

import type { ModelMessage } from "ai";
import { runFixoAgent } from "../fixo/agent.ts";
import { scoreDiagnosis } from "./diagnosis-score.ts";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Single customer turn. Phrased to carry enough detail that the agent can
   *  reach a diagnosis (and an estimate where asked) without a back-and-forth. */
  prompt: string;
  /** Tool names that SHOULD appear in the trace. */
  expectTools?: string[];
  /** Each inner array is an OR-group: the final text must hit ≥1 term in each. */
  mustMentionAnyOf?: string[][];
  /** True if the run should end with a create_estimate. */
  expectEstimate?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "brake-pads-rotors",
    prompt: "My 2015 Honda Civic has about 90,000 miles. When I brake at low speed there's a " +
      "grinding/squealing noise from the front, and braking hard from highway speed shakes " +
      "the steering wheel. No warning lights, it doesn't pull to either side, and the grinding " +
      "is getting louder over the past week. It's my daily driver and I can't take photos right " +
      "now. Give me your best diagnosis and a price estimate for the likely fix.",
    expectTools: ["isolate_systems", "create_estimate"],
    mustMentionAnyOf: [["rotor", "rotors"], ["pad", "pads"]],
    expectEstimate: true,
  },
  {
    name: "obd-lean-both-banks",
    prompt:
      "2013 Ford F-150 with the 5.0L V8, 110k miles. Check engine light is on. My code reader " +
      "shows P0171 and P0174. It idles a little rough and hesitates slightly on light " +
      "acceleration. What's going on and what should I check first?",
    expectTools: ["lookupObdCode", "isolate_systems"],
    mustMentionAnyOf: [["lean", "vacuum", "intake", "maf", "mass air", "fuel"]],
  },
  {
    name: "no-start-clicking",
    prompt: "2016 Toyota Camry. This morning it won't start. When I turn the key it just clicks " +
      "rapidly and the dashboard lights dim. Headlights are weak. What's the likely cause and " +
      "how do I confirm it?",
    expectTools: ["isolate_systems"],
    mustMentionAnyOf: [["battery", "starter", "charge", "voltage"]],
  },
  {
    name: "misfire-p0301-flashing",
    prompt:
      "2014 Volkswagen Jetta 1.8T, 85k miles. Check engine light is FLASHING, code reader shows " +
      "P0300 and P0301. The engine shakes at idle and I can smell gas. Is it safe to drive and " +
      "what's the fix?",
    expectTools: ["lookupObdCode", "isolate_systems"],
    mustMentionAnyOf: [
      ["misfire", "coil", "spark", "ignition", "plug"],
      ["catalytic", "stop driving", "don't drive", "do not drive", "tow", "unsafe", "safe"],
    ],
  },
  {
    name: "overheat-cruze",
    prompt:
      "2012 Chevy Cruze 1.4 turbo. The temperature gauge climbs toward red when I'm stuck in " +
      "traffic, there's a sweet smell, and the coolant reservoir is low. What's wrong and what " +
      "tests should I run before I take it in?",
    expectTools: ["isolate_systems"],
    mustMentionAnyOf: [["coolant", "water pump", "head gasket", "thermostat", "leak", "radiator"]],
  },
];

// ---------------------------------------------------------------------------
// Stream consumption
// ---------------------------------------------------------------------------

interface ToolCall {
  name: string;
  input: unknown;
}
interface ToolResultEntry {
  name: string;
  output: unknown;
}
interface RunResult {
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultEntry[];
  errors: unknown[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
}

async function runScenario(s: Scenario): Promise<RunResult> {
  const messages: ModelMessage[] = [{ role: "user", content: s.prompt }];
  const result = runFixoAgent({ messages });

  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResultEntry[] = [];
  const errors: unknown[] = [];
  let text = "";

  // Iterate the full stream so we capture every tool call/result and any error.
  for await (const part of result.fullStream) {
    // deno-lint-ignore no-explicit-any
    const p = part as any;
    switch (p.type) {
      case "text-delta":
      case "text":
        text += p.text ?? p.textDelta ?? p.delta ?? "";
        break;
      case "tool-call":
        toolCalls.push({ name: p.toolName, input: p.input ?? p.args });
        break;
      case "tool-result":
        toolResults.push({ name: p.toolName, output: p.output ?? p.result });
        break;
      case "error":
        errors.push(p.error ?? p);
        break;
    }
  }

  const out: RunResult = { text, toolCalls, toolResults, errors };
  try {
    out.usage = await result.totalUsage;
  } catch {
    try {
      out.usage = await result.usage;
    } catch { /* ignore */ }
  }
  try {
    out.finishReason = await result.finishReason;
  } catch { /* ignore */ }
  if (!out.text) {
    try {
      out.text = await result.text;
    } catch { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively find the first value for `key` anywhere in a nested object. */
// deno-lint-ignore no-explicit-any
function deepFind(obj: any, key: string): any {
  if (obj == null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function truncate(v: unknown, max = 600): string {
  let str: string;
  try {
    str = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    str = String(v);
  }
  return str.length > max ? str.slice(0, max) + ` …(+${str.length - max} chars)` : str;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/** Heuristic check on whether the brake estimate doubled the rotor price.
 *  Rotors are sold per-unit; a front brake job needs 2. Returns a note string. */
function rotorQtyNote(r: RunResult): string | undefined {
  const estCall = r.toolCalls.find((t) => t.name === "create_estimate");
  if (!estCall) return undefined;
  // Collect partsCost values the agent passed.
  const services = deepFind(estCall.input, "services");
  if (!Array.isArray(services)) return undefined;
  const partsCosts = services
    .map((s) => (typeof s?.partsCost === "number" ? s.partsCost : undefined))
    .filter((n): n is number => n !== undefined);

  // Find recommended per-unit prices the parts lookups returned.
  const partsResults = r.toolResults.filter((t) => t.name === "lookup_parts_price");
  const recs: { query: string; recommended: number }[] = [];
  for (const pr of partsResults) {
    const recommended = deepFind(pr.output, "recommendedPrice") ??
      deepFind(pr.output, "recommended");
    const query = deepFind(pr.output, "partName") ?? deepFind(pr.output, "query") ??
      deepFind(pr.output, "part") ?? "?";
    if (typeof recommended === "number") recs.push({ query: String(query), recommended });
  }
  const rotor = recs.find((x) => /rotor/i.test(x.query));
  const pad = recs.find((x) => /pad/i.test(x.query));
  if (!rotor) {
    return `parts passed=${truncate(partsCosts)} (no rotor parts-lookup recommended price found)`;
  }

  const single = (pad?.recommended ?? 0) + rotor.recommended;
  const doubled = (pad?.recommended ?? 0) + 2 * rotor.recommended;
  const within = (a: number, b: number) => b > 0 && Math.abs(a - b) / b <= 0.15;
  let verdict = "ambiguous";
  for (const pc of partsCosts) {
    if (within(pc, doubled)) verdict = "rotors DOUBLED ✓";
    else if (within(pc, single)) verdict = "rotors NOT doubled ✗ (undercounts a front job)";
  }
  return `partsCost passed=${truncate(partsCosts)} | pad rec=$${
    pad?.recommended ?? "?"
  } rotor rec=$${rotor.recommended} ` +
    `| 1×rotor target=$${single.toFixed(2)} 2×rotor target=$${doubled.toFixed(2)} → ${verdict}`;
}

interface CheckResult {
  label: string;
  pass: boolean | "info";
  detail?: string;
}

function checkScenario(s: Scenario, r: RunResult): CheckResult[] {
  const checks: CheckResult[] = [];
  const calledNames = new Set(r.toolCalls.map((t) => t.name));
  const lowerText = r.text.toLowerCase();

  for (const tool of s.expectTools ?? []) {
    checks.push({ label: `called ${tool}`, pass: calledNames.has(tool) });
  }
  for (const group of s.mustMentionAnyOf ?? []) {
    const hit = group.find((term) => lowerText.includes(term.toLowerCase()));
    checks.push({
      label: `mentions one of [${group.join(", ")}]`,
      pass: !!hit,
      detail: hit ? `matched "${hit}"` : undefined,
    });
  }
  if (s.expectEstimate) {
    const est = r.toolResults.find((t) => t.name === "create_estimate");
    const subtotal = est ? deepFind(est.output, "subtotal") : undefined;
    const priceRange = est ? deepFind(est.output, "priceRange") : undefined;
    checks.push({
      label: "produced an estimate",
      pass: !!est,
      detail: est ? `subtotal=$${subtotal} range=${priceRange}` : undefined,
    });
  }
  if (r.errors.length > 0) {
    checks.push({ label: "no stream errors", pass: false, detail: truncate(r.errors) });
  }
  const rotorNote = rotorQtyNote(r);
  if (rotorNote) checks.push({ label: "rotor-qty heuristic", pass: "info", detail: rotorNote });

  return checks;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTrace(s: Scenario, r: RunResult, checks: CheckResult[]) {
  console.log(`\n${C.bold}${C.cyan}=== SCENARIO: ${s.name} ===${C.reset}`);
  console.log(`${C.dim}${s.prompt}${C.reset}\n`);

  console.log(`${C.bold}— tool chain (${r.toolCalls.length} calls) —${C.reset}`);
  for (let i = 0; i < r.toolCalls.length; i++) {
    const call = r.toolCalls[i];
    const res = r.toolResults[i];
    console.log(`  ${i + 1}. ${C.yellow}${call.name}${C.reset}(${truncate(call.input, 240)})`);
    if (res) console.log(`     ${C.dim}→ ${truncate(res.output, 240)}${C.reset}`);
  }

  console.log(`\n${C.bold}— final message —${C.reset}`);
  console.log(
    r.text.trim() ? r.text.trim() : `${C.dim}(no text — finishReason=${r.finishReason})${C.reset}`,
  );

  console.log(`\n${C.bold}— checks —${C.reset}`);
  for (const c of checks) {
    const mark = c.pass === "info"
      ? `${C.cyan}ℹ${C.reset}`
      : c.pass
      ? `${C.green}✓${C.reset}`
      : `${C.red}✗${C.reset}`;
    console.log(`  ${mark} ${c.label}${c.detail ? ` ${C.dim}— ${c.detail}${C.reset}` : ""}`);
  }

  const u = r.usage;
  console.log(
    `\n${C.dim}finishReason=${r.finishReason} | tokens in/out=${u?.inputTokens ?? "?"}/${
      u?.outputTokens ?? "?"
    } | ` +
      `tool calls=${r.toolCalls.length}${C.reset}`,
  );
}

// ---------------------------------------------------------------------------
// Real-pair accuracy eval (--real)
// ---------------------------------------------------------------------------

interface RealPair {
  orderId: number;
  symptom: string;
  truth: string;
}

/** Pull real (symptom → confirmed_diagnosis) pairs from the DB. Read-only;
 *  needs DATABASE_URL (Infisical injects it). Returns [] until mechanics
 *  actually fill confirmed_diagnosis (see Phase 0 plan, Task 2). */
async function fetchRealPairs(limit: number): Promise<RealPair[]> {
  const { db, schema } = await import("../db/client.ts");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({
      orderId: schema.orders.id,
      symptom: schema.orderIntake.symptomDescription,
      truth: schema.orders.confirmedDiagnosis,
    })
    .from(schema.orders)
    .innerJoin(schema.orderIntake, eq(schema.orderIntake.orderId, schema.orders.id))
    .where(
      and(
        isNotNull(schema.orders.confirmedDiagnosis),
        isNotNull(schema.orderIntake.symptomDescription),
      ),
    )
    .limit(limit);
  return rows
    .filter((r) => !!r.symptom?.trim() && !!r.truth?.trim())
    .map((r) => ({ orderId: r.orderId, symptom: r.symptom as string, truth: r.truth as string }));
}

async function runRealEval(limit: number, json: boolean) {
  const pairs = await fetchRealPairs(limit);
  console.log(
    `${C.bold}Fixo accuracy eval (real pairs)${C.reset} — ${pairs.length} ` +
      `(symptom → confirmed_diagnosis) pair(s)`,
  );
  if (pairs.length === 0) {
    console.log(
      `${C.yellow}No pairs yet.${C.reset} confirmed_diagnosis is unfilled — enforce capture ` +
        `first (Phase 0 plan, Task 2), then re-run.`,
    );
    return;
  }

  // deno-lint-ignore no-explicit-any
  const structured: any[] = [];
  let scoreSum = 0;
  for (const p of pairs) {
    const r = await runScenario({ name: `order-${p.orderId}`, prompt: p.symptom });
    const sc = scoreDiagnosis(r.text, p.truth);
    scoreSum += sc.score;

    console.log(`\n${C.bold}${C.cyan}=== ORDER ${p.orderId} ===${C.reset}`);
    console.log(`${C.dim}symptom:${C.reset} ${truncate(p.symptom, 240)}`);
    console.log(`${C.dim}truth:  ${C.reset} ${truncate(p.truth, 240)}`);
    console.log(`${C.dim}brain:  ${C.reset} ${truncate(r.text, 240)}`);
    const mark = sc.score >= 0.5 ? C.green : C.red;
    console.log(
      `${mark}score=${sc.score.toFixed(2)}${C.reset} ` +
        `matched=[${sc.matched.join(", ")}] missed=[${sc.missed.join(", ")}]`,
    );
    structured.push({
      orderId: p.orderId,
      symptom: p.symptom,
      truth: p.truth,
      brain: r.text,
      ...sc,
    });
  }

  const mean = scoreSum / pairs.length;
  console.log(
    `\n${C.bold}════ ACCURACY ════${C.reset} mean term-recall = ${(mean * 100).toFixed(1)}% ` +
      `over ${pairs.length} pair(s)`,
  );
  if (json) console.log("\n" + JSON.stringify(structured, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(args: string[]) {
  let filter: string | undefined;
  let list = false;
  let json = false;
  let real = false;
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") list = true;
    else if (a === "--json") json = true;
    else if (a === "--real") real = true;
    else if (a === "--filter") filter = args[++i];
    else if (a.startsWith("--filter=")) filter = a.slice("--filter=".length);
    else if (a === "--limit") limit = Number(args[++i]) || limit;
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length)) || limit;
  }
  return { filter, list, json, real, limit };
}

async function main() {
  const { filter, list, json, real, limit } = parseArgs(Deno.args);

  if (!Deno.env.get("GOOGLE_API_KEY")) {
    console.error(
      `${C.red}GOOGLE_API_KEY missing.${C.reset} Run via: ` +
        `infisical run --env=dev -- deno run -A apps/agent/src/scripts/fixo-eval.ts`,
    );
    Deno.exit(1);
  }

  if (real) {
    if (!Deno.env.get("DATABASE_URL")) {
      console.error(
        `${C.red}DATABASE_URL missing.${C.reset} --real reads the DB (Infisical injects it).`,
      );
      Deno.exit(1);
    }
    await runRealEval(limit, json);
    return;
  }

  const selected = SCENARIOS.filter((s) => !filter || s.name.includes(filter));

  if (list) {
    console.log("Scenarios:");
    for (const s of SCENARIOS) console.log(`  - ${s.name}`);
    return;
  }
  if (selected.length === 0) {
    console.error(`No scenarios match filter "${filter}". Use --list.`);
    Deno.exit(1);
  }

  console.log(
    `${C.bold}Fixo capability harness${C.reset} — ${selected.length} scenario(s), model=${
      Deno.env.get("AGENT_MODEL") ?? "gemini-3-flash-preview"
    } (read-only, no DB writes, no credits)`,
  );

  // deno-lint-ignore no-explicit-any
  const structured: any[] = [];
  let totalIn = 0;
  let totalOut = 0;
  const summary: { name: string; passed: number; total: number; failed: string[] }[] = [];

  for (const s of selected) {
    let r: RunResult;
    try {
      r = await runScenario(s);
    } catch (err) {
      console.error(
        `\n${C.red}✗ ${s.name} threw:${C.reset} ${err instanceof Error ? err.stack : err}`,
      );
      summary.push({ name: s.name, passed: 0, total: 1, failed: ["threw"] });
      continue;
    }
    const checks = checkScenario(s, r);
    printTrace(s, r, checks);

    totalIn += r.usage?.inputTokens ?? 0;
    totalOut += r.usage?.outputTokens ?? 0;

    const real = checks.filter((c) => c.pass !== "info");
    const passed = real.filter((c) => c.pass === true).length;
    summary.push({
      name: s.name,
      passed,
      total: real.length,
      failed: real.filter((c) => c.pass === false).map((c) => c.label),
    });
    structured.push({ scenario: s.name, prompt: s.prompt, ...r, checks });
  }

  console.log(`\n${C.bold}════ SUMMARY ════${C.reset}`);
  for (const row of summary) {
    const ok = row.passed === row.total;
    const mark = ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(
      `  ${mark} ${row.name} (${row.passed}/${row.total})${
        row.failed.length ? ` ${C.dim}— missing: ${row.failed.join(", ")}${C.reset}` : ""
      }`,
    );
  }
  console.log(`${C.dim}total tokens in/out = ${totalIn}/${totalOut}${C.reset}`);

  if (json) {
    console.log("\n" + JSON.stringify(structured, null, 2));
  }
}

if (import.meta.main) {
  await main();
}
