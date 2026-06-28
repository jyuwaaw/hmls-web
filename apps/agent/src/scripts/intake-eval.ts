// apps/agent/src/scripts/intake-eval.ts
//
// Intake-behavior eval for the HMLS customer agent. Runs runHmlsAgent on a
// scripted single turn and checks: (1) repair symptom → diagnose_symptom is
// called BEFORE create_order; (2) the assistant TEXT never leaks internalScope
// jargon (candidate-system / root-cause terms); (3) maintenance → diagnose_symptom
// is NOT called. Real model + OLP DB.
//
// Model switch: set HMLS_AGENT_MODEL to A/B DeepSeek models (deepseek-v4-flash vs
// deepseek-v4-pro) — the HMLS agent reads it from env, separate from Fixo's
// AGENT_MODEL so the two providers never share a model id. The HMLS agent is
// DeepSeek-only now; a Gemini id would 404. Rolling back to Gemini is a code
// change in agent.ts.
//
// Run: infisical run --env=dev -- deno run -A apps/agent/src/scripts/intake-eval.ts
//      HMLS_AGENT_MODEL=deepseek-v4-pro infisical run --env=dev -- deno run -A apps/agent/src/scripts/intake-eval.ts
import { runHmlsAgent } from "../hmls/agent.ts";

// Agent needs DEEPSEEK_API_KEY; diagnose_symptom (Fixo brain) still needs GOOGLE_API_KEY.
for (const k of ["DEEPSEEK_API_KEY", "GOOGLE_API_KEY"]) {
  if (!Deno.env.get(k)) {
    console.error(`${k} required (run via infisical).`);
    Deno.exit(2);
  }
}
const agentModel = Deno.env.get("HMLS_AGENT_MODEL") || undefined;
console.log(`model: ${agentModel ?? "(default) deepseek-v4-pro"}\n`);

interface Trace {
  toolOrder: string[];
  text: string;
}

async function runTurn(prompt: string): Promise<Trace> {
  const result = await runHmlsAgent({
    messages: [{ role: "user", content: prompt }],
  });
  const toolOrder: string[] = [];
  let text = "";
  for await (const part of result.fullStream) {
    // deno-lint-ignore no-explicit-any
    const p = part as any;
    if (p.type === "tool-call" && p.toolName) toolOrder.push(p.toolName as string);
    if (p.type === "text-delta") text += p.text ?? p.textDelta ?? p.delta ?? "";
  }
  await result.text;
  return { toolOrder, text };
}

// Leak terms: candidate-system / root-cause vocabulary that must never reach the customer.
const LEAK_TERMS = ["candidate system", "root cause", "ignition system", "fuel system"];

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

// Scenario A — repair symptom (no address → create_order writes nothing).
{
  const t = await runTurn(
    "My 2015 Honda Civic, 90k miles, has a grinding/squealing noise from the front when I brake " +
      "at low speed, getting louder this week. No warning lights.",
  );
  const di = t.toolOrder.indexOf("diagnose_symptom");
  const co = t.toolOrder.indexOf("create_order");
  check("repair: diagnose_symptom is called", di >= 0, `tools=${t.toolOrder.join(",")}`);
  check(
    "repair: diagnose_symptom precedes create_order (if both ran)",
    di >= 0 && (co < 0 || di < co),
    `tools=${t.toolOrder.join(",")}`,
  );
  const leaked = LEAK_TERMS.filter((term) => t.text.toLowerCase().includes(term));
  check(
    "repair: no internalScope leak in assistant text",
    leaked.length === 0,
    `leaked=${leaked.join(",")}`,
  );
}

// Scenario B — routine maintenance (must NOT diagnose).
{
  const t = await runTurn("I just need an oil change for my 2020 Toyota Camry.");
  check(
    "maintenance: diagnose_symptom is NOT called",
    !t.toolOrder.includes("diagnose_symptom"),
    `tools=${t.toolOrder.join(",")}`,
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
Deno.exit(failures === 0 ? 0 : 1);
