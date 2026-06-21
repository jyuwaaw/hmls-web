-- Fixo public-API keys — external callers of the diagnose/estimate API + MCP.
--
-- Stores only the SHA-256 hash of each key (apps/agent/src/fixo/lib/api-keys.ts);
-- the plaintext is shown once at mint and never persisted. Looked up by key_hash
-- among rows where revoked_at IS NULL.
--
-- Hand-written: drizzle-kit's journal is out of sync with the on-disk migrations
-- (see 0026), so `deno task db:generate` is unsafe. Apply via the production
-- migration path.

CREATE TABLE IF NOT EXISTS fixo_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
