import { assertMatch, assertNotEquals } from "@std/assert";
import { newPredictionId } from "./brain-service.ts";

Deno.test("newPredictionId — prefixed UUID, unique per call", () => {
  const a = newPredictionId();
  const b = newPredictionId();
  assertMatch(a, /^pred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assertNotEquals(a, b);
});
