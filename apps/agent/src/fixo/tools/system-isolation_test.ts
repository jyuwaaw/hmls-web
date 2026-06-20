import { assertEquals } from "@std/assert";
import { isolateSystems } from "./system-isolation.ts";

Deno.test("isolateSystems — no signal yields no candidates", () => {
  assertEquals(isolateSystems({}), []);
  assertEquals(isolateSystems({ symptomDescription: "" }), []);
});

Deno.test("isolateSystems — a DTC system label yields a high-confidence candidate", () => {
  // Unknown labels fall back to the lowercased label itself, always confidence 3.
  const out = isolateSystems({ dtcSystems: ["Ignition"] });
  assertEquals(out.length >= 1, true);
  for (const c of out) assertEquals(c.confidence, 3);
});

Deno.test("isolateSystems — candidates are sorted by confidence descending", () => {
  const out = isolateSystems({
    symptomDescription: "engine shakes at idle and the check engine light is on",
    dtcSystems: ["Ignition"],
  });
  for (let i = 1; i < out.length; i++) {
    assertEquals(out[i - 1].confidence >= out[i].confidence, true);
  }
});
