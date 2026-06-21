// Single-shot structured brain run for the public Fixo API (POST /v1/diagnose).
//
// Drives the full Fixo agent (`runFixoAgent`) for ONE turn with no session /
// no userId — stateless, spends no credits — and captures the agent's
// `emit_diagnosis` tool call as a typed StructuredDiagnosis.  The pure
// stream-drain helper lives in diagnose-drain.ts so tests can verify it
// without loading this heavy import graph.

import type { ModelMessage } from "ai";
import { runFixoAgent } from "./agent.ts";
import { buildStructuredDiagnosePrompt, type DiagnoseOnceInput } from "./run-once-prompt.ts";
import { type StructuredDiagnosis, structuredDiagnosisSchema } from "./diagnosis-schema.ts";
import { pickEmitDiagnosis } from "./diagnose-drain.ts";

export type { DiagnoseOnceInput, StructuredDiagnosis };

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
  await result.text; // ensure the run has settled

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
