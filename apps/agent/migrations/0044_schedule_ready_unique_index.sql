-- 0044: schedule_ready_notified dedup — partial UNIQUE index (Codex C6)
--
-- Guarantees one "appointment confirmed" email per order:
-- claimScheduleReadyNotification() inserts with ON CONFLICT DO NOTHING against
-- THIS index — the winner sends, losers skip. Concurrent slot/mechanic pair
-- completions therefore dedup to a single send.
--
-- ⚠️ DEPLOY ORDER — this index must exist BEFORE the PR-2 code goes live:
--     1. apply 0043 (adds the 'schedule_ready_notified' enum value)
--     2. apply 0044 (this file — the dedup index)
--     3. DEPLOY the PR-2 code (alias-tolerant readers + claimScheduleReady…)
--     4. apply 0045 (the status remap — needs the new code to already be live)
-- It lives in its own file, NOT in 0043: a value added by ALTER TYPE … ADD
-- VALUE cannot be USED in the same transaction (db-apply.sh runs each file as
-- --single-transaction), and an enum→text cast in the predicate isn't
-- IMMUTABLE. One transaction later, the plain enum-literal predicate is fine.
--
-- Applying this before any 'schedule_ready_notified' rows exist (code not yet
-- live) also means CREATE UNIQUE INDEX can never abort on a pre-existing
-- duplicate. Idempotent — safe to rerun.

CREATE UNIQUE INDEX IF NOT EXISTS order_events_schedule_ready_once_idx
  ON order_events (order_id)
  WHERE event_type = 'schedule_ready_notified';
