-- Auto-cancel abandoned draft orders.
--
-- A draft order is created the moment the AI agent runs `create_order`. If the
-- customer abandons mid-conversation the row sits forever, polluting the
-- admin draft queue and growing the table unboundedly. This migration adds:
--
--   1. `cancel_abandoned_drafts(stale_days int)` — flips drafts that haven't
--      been touched in `stale_days` days AND have no `scheduled_at` into
--      `cancelled`, with `cancellationReason: 'abandoned (no activity for
--      N days)'` and a matching `order_events` row. Returns the count
--      cancelled.
--
--   2. A daily pg_cron job at 03:00 UTC that runs the function with a
--      14-day threshold.
--
-- Cancelled orders are NEVER auto-deleted — they stay as audit history.
-- Drafts with a tentative `scheduled_at` are left alone (those are the
-- chat-flow shortcut where the customer already picked a time and is
-- waiting on shop confirm).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION cancel_abandoned_drafts(stale_days INTEGER DEFAULT 14)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  cancelled_count INTEGER;
  cutoff TIMESTAMPTZ := now() - make_interval(days => stale_days);
  reason TEXT := format('abandoned (no activity for %s days)', stale_days);
  now_ts TIMESTAMPTZ := now();
  -- Match the JS `Date.toISOString()` shape that the app writes everywhere
  -- else into `status_history`, so the audit log stays uniform.
  now_iso TEXT := to_char(now_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  WITH updated AS (
    UPDATE orders
    SET status = 'cancelled',
        cancellation_reason = reason,
        status_history = status_history || jsonb_build_array(
          jsonb_build_object(
            'status', 'cancelled',
            'timestamp', now_iso,
            'actor', 'system:abandoned-cleanup'
          )
        ),
        updated_at = now_ts
    WHERE status = 'draft'
      AND scheduled_at IS NULL
      AND updated_at < cutoff
    RETURNING id
  )
  INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, metadata)
  SELECT id, 'status_change', 'draft', 'cancelled', 'system:abandoned-cleanup',
         jsonb_build_object('reason', reason, 'stale_days', stale_days)
  FROM updated;

  GET DIAGNOSTICS cancelled_count = ROW_COUNT;
  RETURN cancelled_count;
END;
$$;

-- Re-runnable: drop any previous schedule before re-adding.
DO $$
BEGIN
  PERFORM cron.unschedule('cancel-abandoned-drafts');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'cancel-abandoned-drafts',
  '0 3 * * *',
  $$SELECT cancel_abandoned_drafts(14);$$
);

COMMIT;
