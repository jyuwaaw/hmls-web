// Pure key extraction. No @hmls/agent import, so it's unit-testable without
// loading the heavy agent graph.

/** Pull the raw key out of `Authorization: Bearer <key>` or `X-API-Key`. */
export function extractKey(authHeader: string | null, xApiKey: string | null): string {
  return (authHeader ?? xApiKey ?? "").replace(/^Bearer\s+/i, "").trim();
}
