-- 0043: order_events(order_id, created_at) index + schedule_ready enum value
--
-- Prep for the 9→7 status collapse. TWO pieces:
--   1. order_events(order_id, created_at) index — the event feed is always
--      read as "this order's events, newest first" (TODOS.md debt; the remap
--      in 0045 inserts one event per remapped row, so land the index first).
--   2. 'schedule_ready_notified' event value on the order_event_type enum.
--      The partial UNIQUE index that dedups it lives in 0044, NOT here:
--      db-apply.sh runs each file as --single-transaction, and a value added
--      by ALTER TYPE ... ADD VALUE cannot be USED (in an index predicate) in
--      the same transaction — 0044 is one transaction later.
--
-- Apply BEFORE 0044/0045 and BEFORE deploying the PR-2 code. Idempotent.

ALTER TYPE order_event_type ADD VALUE IF NOT EXISTS 'schedule_ready_notified';

CREATE INDEX IF NOT EXISTS order_events_order_id_created_at_idx
  ON order_events (order_id, created_at);
