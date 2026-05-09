-- Add `diagnostic_state` jsonb column to fixo_sessions so the Fixo agent can
-- persist a structured 8-step diagnostic state across turns instead of
-- relying on free-form summarization.
--
-- Shape (defined in @hmls/shared DiagnosticState):
--   { intake?, visual?, dtcs?, candidateSystems?, testsPlanned?, testsDone?,
--     rootCause?, estimateTiers?, notes? }
--
-- All existing rows backfill to '{}' so old sessions keep working — the agent
-- treats an empty state as "fresh diagnostic" and starts from intake.

BEGIN;

ALTER TABLE public.fixo_sessions
  ADD COLUMN diagnostic_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
