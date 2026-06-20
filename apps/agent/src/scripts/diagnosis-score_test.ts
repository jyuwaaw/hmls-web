import { assertEquals } from "@std/assert";
import { scoreDiagnosis } from "./diagnosis-score.ts";

Deno.test("scoreDiagnosis — full term coverage scores 1.0", () => {
  const r = scoreDiagnosis(
    "Worn front brake pads and warped rotors.",
    "front brake pads and rotors",
  );
  assertEquals(r.score, 1);
  assertEquals(r.missed, []);
});

Deno.test("scoreDiagnosis — partial coverage scores the matched fraction", () => {
  const r = scoreDiagnosis(
    "It was just a dead battery.",
    "dead battery and corroded terminals",
  );
  assertEquals([...r.matched].sort(), ["battery", "dead"]);
  assertEquals(r.score, 0.5);
});

Deno.test("scoreDiagnosis — disjoint text scores 0", () => {
  const r = scoreDiagnosis("spark plugs and coils", "water pump leak");
  assertEquals(r.score, 0);
  assertEquals(r.matched, []);
});

Deno.test("scoreDiagnosis — empty truth scores 0 (no divide-by-zero)", () => {
  const r = scoreDiagnosis("anything at all", "");
  assertEquals(r.score, 0);
});
