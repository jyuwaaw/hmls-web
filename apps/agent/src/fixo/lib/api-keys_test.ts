import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { generateApiKey, hashApiKey } from "./api-keys.ts";

Deno.test("hashApiKey — deterministic, 64-hex SHA-256", () => {
  assertEquals(hashApiKey("fixo_sk_abc"), hashApiKey("fixo_sk_abc"));
  assertMatch(hashApiKey("fixo_sk_abc"), /^[0-9a-f]{64}$/);
  assertNotEquals(hashApiKey("fixo_sk_abc"), hashApiKey("fixo_sk_xyz"));
});

Deno.test("generateApiKey — prefixed, unique, hash matches the plaintext", () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assertMatch(a.key, /^fixo_sk_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url = 43 chars
  assertNotEquals(a.key, b.key);
  assertEquals(a.hash, hashApiKey(a.key));
  assertNotEquals(a.hash, b.hash);
});
