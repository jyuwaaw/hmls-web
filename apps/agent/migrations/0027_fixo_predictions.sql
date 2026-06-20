-- Fixo prediction store + the order↔prediction soft link.
--
-- The brain writes one fixo_predictions row per diagnose/estimate call, keyed by
-- the predictionId it mints. recordOutcome() later fills the outcome columns
-- (confirmed_diagnosis, actual_cost_cents, outcome_at) on the same row by
-- predictionId — that (prediction → confirmed truth) pair is the calibration
-- loop's ground truth. orders.fixo_prediction_id is the soft, FK-less link from
-- a shop order back to the prediction that drove it (Fixo and HMLS stay
-- decoupled — no foreign key across the boundary).
--
-- Hand-written: drizzle-kit's journal (apps/agent/migrations/meta/_journal.json)
-- is out of sync with the on-disk migrations (see the 0026 header), so
-- `deno task db:generate` is unsafe. Apply via the production migration path.

CREATE TABLE IF NOT EXISTS fixo_predictions (
  id text PRIMARY KEY,
  vehicle_info jsonb,
  symptom text,
  dtcs jsonb,
  predicted_diagnosis jsonb,
  predicted_estimate jsonb,
  confirmed_diagnosis text,
  actual_cost_cents integer,
  outcome_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS fixo_prediction_id varchar(64);
