-- 0044: 9→7 status collapse — remap physical rows
--
--   scheduled → approved   (scheduling = scheduled_at + provider_id columns)
--   revised   → draft      (revision-in-progress = draft whose status_history
--                           contains 'estimated'; see hasBeenSentToCustomer)
--
-- ⚠️ ORDER OF OPERATIONS: apply 0043 (enum value) + 0044 (dedup index) first,
-- then DEPLOY the alias-tolerant code (canonicalizeStatus reads legacy labels
-- as canonical), THEN run this remap. Old code writing new 'scheduled' rows
-- during the window is fine — rerunning this file converges them (fully
-- idempotent: a second run touches 0 rows and inserts no duplicate events).
--
-- The order_status PG enum keeps the legacy labels — NO type surgery.
-- order_events history rows referencing them are untouched.
--
-- Per-row bookkeeping (order-state invariants #2/#3): every remapped row gets
-- a status_history append AND a status_change order_events row, actor
-- 'system:migration', metadata.reason 'migration_0044_status_collapse'.
--
-- 0041 grants contract: no new columns added here, so no GRANTs needed
-- (migrations run as the admin role via scripts/db-apply.sh anyway).
--
-- ROLLBACK RECIPE (only with pre-collapse code redeployed; NEVER a blind
-- full-table update). The system:migration events written below are the
-- exact affected-row list:
--
--   -- scheduled rows: restore only those still approved AND operable
--   -- (slot + mechanic present — the old machine's scheduled invariant):
--   UPDATE orders o
--   SET status = 'scheduled'
--   FROM order_events e
--   WHERE e.order_id = o.id
--     AND e.actor = 'system:migration'
--     AND e.metadata->>'reason' = 'migration_0044_status_collapse'
--     AND e.from_status = 'scheduled'
--     AND o.status = 'approved'
--     AND o.scheduled_at IS NOT NULL AND o.provider_id IS NOT NULL;
--   -- (append matching status_history entries + insert order_events rows
--   --  with actor 'system:migration-rollback'; suppress notifications.)
--   -- revised→draft rows need NO reversal: the old machine's draft is
--   -- equally editable and sendable.

-- (The schedule_ready dedup unique index is created in 0044, applied before the
-- code deploys — see that file's header for why it can't share 0043's tx.)

DO $$
DECLARE
  r RECORD;
  new_status order_status;
BEGIN
  FOR r IN
    SELECT id, status
    FROM orders
    WHERE status IN ('scheduled', 'revised')
    FOR UPDATE
  LOOP
    new_status := CASE r.status::text
      WHEN 'scheduled' THEN 'approved'::order_status
      ELSE 'draft'::order_status
    END;

    UPDATE orders
    SET status = new_status,
        status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_object(
          'status', new_status::text,
          'timestamp',
          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'actor', 'system:migration'
        ),
        updated_at = now()
    WHERE id = r.id;

    INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, metadata)
    VALUES (
      r.id,
      'status_change',
      r.status::text,
      new_status::text,
      'system:migration',
      jsonb_build_object('reason', 'migration_0044_status_collapse')
    );
  END LOOP;
END $$;
