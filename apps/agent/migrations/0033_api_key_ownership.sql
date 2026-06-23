-- 0033_api_key_ownership.sql — self-serve key ownership + per-key rate limiting.
-- Authored; apply post-deploy via psql -f (db:migrate skips hand-written SQL).
BEGIN;

-- Owner of a self-serve key (NULL for operator/manually-minted keys).
ALTER TABLE fixo_api_keys  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES user_profiles(id);
-- Which key created a prediction (NULL for in-process/legacy predictions).
ALTER TABLE fixo_predictions ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES fixo_api_keys(id);

CREATE INDEX IF NOT EXISTS fixo_api_keys_user_id_idx ON fixo_api_keys(user_id);

-- Fixed-window rate-limit counters. bucket = e.g. 'min:2026-06-22T16:45' / 'day:2026-06-22'.
CREATE TABLE IF NOT EXISTS fixo_rate_limit (
  key_id  uuid NOT NULL,
  bucket  text NOT NULL,
  count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket)
);

COMMIT;
