import { assert, assertEquals } from "@std/assert";
import { buildStructuredDiagnosePrompt } from "./run-once-prompt.ts";
import { pickEmitDiagnosis } from "./diagnose-drain.ts";

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

Deno.test("buildStructuredDiagnosePrompt — instructs emit_diagnosis + no questions", () => {
  const p = buildStructuredDiagnosePrompt({
    vehicle: { year: 2018, make: "Honda", model: "Civic" },
    symptom: "grinding when braking",
  });
  assert(p.includes("Honda"));
  assert(p.includes("emit_diagnosis"));
  assert(/do not ask|don't ask/i.test(p));
});
