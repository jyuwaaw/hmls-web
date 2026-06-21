// Single-shot brain run for the public REST/MCP API: one symptom in, the
// agent's diagnosis + estimate out.
//
// Same engine the chat uses (`runFixoAgent`, the 5/5-on-eval agent), driven for
// ONE turn with no session / no userId — read-only, spends no Fixo credits — and
// drained to a plain JSON result. This is the proven full agent, NOT the loop's
// shallow rule `BrainService.diagnose()`. The pure prompt builder lives in
// run-once-prompt.ts so it stays unit-testable without this heavy import graph.

import type { ModelMessage } from "ai";
import { runFixoAgent } from "./agent.ts";
import { buildDiagnosePrompt, type DiagnoseOnceInput } from "./run-once-prompt.ts";

export { buildDiagnosePrompt, type DiagnoseOnceInput };

export interface DiagnoseOnceResult {
  diagnosis: string;
  /** Raw output of the agent's `create_estimate` call, or null if it didn't price. */
  estimate: unknown | null;
}

export async function runFixoOnce(input: DiagnoseOnceInput): Promise<DiagnoseOnceResult> {
  const messages: ModelMessage[] = [{ role: "user", content: buildDiagnosePrompt(input) }];
  const result = runFixoAgent({ messages });

  let estimate: unknown | null = null;
  for await (const part of result.fullStream) {
    // deno-lint-ignore no-explicit-any
    const p = part as any;
    if (p.type === "tool-result" && p.toolName === "create_estimate") {
      estimate = p.output ?? p.result ?? null;
    }
  }
  const diagnosis = await result.text;
  return { diagnosis, estimate };
}
