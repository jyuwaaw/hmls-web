import { assertEquals } from "@std/assert";
import { extractKey } from "./api-key-parse.ts";

Deno.test("extractKey — strips Bearer prefix", () => {
  assertEquals(extractKey("Bearer fixo_sk_abc", null), "fixo_sk_abc");
  assertEquals(extractKey("bearer fixo_sk_abc", null), "fixo_sk_abc");
});

Deno.test("extractKey — accepts a raw key via either header", () => {
  assertEquals(extractKey("fixo_sk_abc", null), "fixo_sk_abc");
  assertEquals(extractKey(null, "fixo_sk_xyz"), "fixo_sk_xyz");
});

Deno.test("extractKey — empty when no header", () => {
  assertEquals(extractKey(null, null), "");
  assertEquals(extractKey("Bearer    ", null), "");
});
