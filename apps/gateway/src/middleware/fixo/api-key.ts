// Fixo public-API key auth. Validates the key from `Authorization: Bearer <key>`
// or `X-API-Key` against fixo_api_keys (hash lookup, see @hmls/agent api-keys).
// Keys are rate-limited per-key (see checkRateLimit); external self-serve keys are now issued.
// Pure header parsing lives in api-key-parse.ts (unit-testable in isolation).

import { checkRateLimit, verifyApiKey } from "@hmls/agent";
import { extractKey } from "./api-key-parse.ts";

export interface ApiKeyContext {
  id: string;
  label: string | null;
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: "UNAUTHORIZED", message } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Validate the presented key. Returns the key context on success, or a 401. */
export async function authenticateApiKey(req: Request): Promise<ApiKeyContext | Response> {
  const key = extractKey(req.headers.get("authorization"), req.headers.get("x-api-key"));
  if (!key) return unauthorized("Missing API key");
  const verified = await verifyApiKey(key);
  if (!verified) return unauthorized("Invalid or revoked API key");
  const rl = await checkRateLimit(verified.id);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: `Rate limit exceeded (${rl.scope})` },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": rl.scope === "min" ? "60" : "3600",
        },
      },
    );
  }
  return verified;
}
