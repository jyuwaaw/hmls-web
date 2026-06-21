import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildDiagnosePrompt } from "./run-once-prompt.ts";

Deno.test("buildDiagnosePrompt — includes vehicle + symptom + ask", () => {
  const p = buildDiagnosePrompt({
    vehicle: { year: 2015, make: "Honda", model: "Civic" },
    symptom: "grinding when braking",
  });
  assertStringIncludes(p, "2015 Honda Civic");
  assertStringIncludes(p, "grinding when braking");
  assertStringIncludes(p, "diagnosis");
});

Deno.test("buildDiagnosePrompt — appends DTC codes only when present", () => {
  const withDtcs = buildDiagnosePrompt({
    vehicle: { year: 2013, make: "Ford", model: "F-150" },
    symptom: "rough idle",
    dtcs: ["P0171", "P0174"],
  });
  assertStringIncludes(withDtcs, "P0171, P0174");

  const without = buildDiagnosePrompt({
    vehicle: { year: 2013, make: "Ford", model: "F-150" },
    symptom: "rough idle",
  });
  assertEquals(without.includes("OBD codes"), false);
});
