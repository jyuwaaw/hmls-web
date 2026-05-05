BEGIN;

-- 1. Create fixo_reports
CREATE TABLE fixo_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  result           jsonb NOT NULL,
  vehicle_snapshot jsonb,
  media_snapshot   jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count    integer NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_reports_session ON fixo_reports(session_id, generated_at DESC);
CREATE INDEX idx_fixo_reports_user    ON fixo_reports(user_id, generated_at DESC);

-- 2. Create fixo_message_events (idempotent quota counter)
CREATE TABLE fixo_message_events (
  user_message_id text  PRIMARY KEY,
  user_id         uuid  NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  month           date  NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_msg_events_user_month ON fixo_message_events(user_id, month);

-- 3. Alter dependent FKs to CASCADE so DELETE /sessions can rely on a single
--    DELETE FROM fixo_sessions wiping dependents.
--    NOTE: The actual constraint names in the DB are the legacy `diagnostic_*`
--    names (these tables were renamed from diagnostic_* without renaming the
--    constraints). We drop the old names and re-add with Drizzle-default names
--    so future drizzle-generated diffs stay clean.
ALTER TABLE fixo_media
  DROP CONSTRAINT diagnostic_media_session_id_fkey,
  ADD CONSTRAINT  fixo_media_session_id_fixo_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES fixo_sessions(id) ON DELETE CASCADE;

ALTER TABLE fixo_obd_codes
  DROP CONSTRAINT diagnostic_obd_codes_session_id_fkey,
  ADD CONSTRAINT  fixo_obd_codes_session_id_fixo_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES fixo_sessions(id) ON DELETE CASCADE;

-- (fixo_estimates intentionally keeps ON DELETE SET NULL — estimates outlive
-- their source session.)

-- 4. Backfill reports from existing fixo_sessions.result.
--    D2 (decision, 2026-05-04): legacy customer-only sessions are NOT migrated.
--    There is no production user base; preserving customer_id-only records would
--    permanently complicate the SaaS-targeted schema for zero real value.
INSERT INTO fixo_reports (
  session_id, user_id, result, vehicle_snapshot, media_snapshot,
  message_count, generated_at
)
SELECT
  s.id,
  s.user_id,
  s.result,
  to_jsonb(v.*),
  COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'type', m.type,
        'storageKey', m.r2_key,
        'transcription', m.transcription,
        'createdAt', m.created_at
      ))
      FROM fixo_media m WHERE m.session_id = s.id
    ),
    '[]'::jsonb
  ),
  COALESCE(jsonb_array_length(s.messages), 0),
  COALESCE(s.completed_at, s.created_at)
FROM fixo_sessions s
LEFT JOIN vehicles v ON v.id = s.vehicle_id
WHERE s.result IS NOT NULL AND s.user_id IS NOT NULL;

-- 5. Add new columns to fixo_sessions
ALTER TABLE fixo_sessions
  ADD COLUMN title text,
  ADD COLUMN title_is_user_set boolean NOT NULL DEFAULT false,
  ADD COLUMN summary text,
  ADD COLUMN last_summarized_message_id text,
  ADD COLUMN last_message_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN archived_at timestamptz;

-- 6. Backfill last_message_at from messages array (fallback to created_at)
UPDATE fixo_sessions
SET last_message_at = COALESCE(
  (
    SELECT MAX( (msg->>'createdAt')::timestamptz )
    FROM jsonb_array_elements(messages) AS msg
    WHERE msg->>'createdAt' IS NOT NULL
  ),
  created_at
);

-- 7. Backfill titles from first user message text part
UPDATE fixo_sessions
SET title = LEFT(
  COALESCE(
    (
      SELECT (part->>'text')
      FROM jsonb_array_elements(messages->0->'parts') AS part
      WHERE part->>'type' = 'text' AND part->>'text' IS NOT NULL
      LIMIT 1
    ),
    'Untitled diagnosis'
  ),
  40
)
WHERE title IS NULL;

-- 8. Drop legacy columns + enum
ALTER TABLE fixo_sessions
  DROP COLUMN result,
  DROP COLUMN status,
  DROP COLUMN completed_at;
DROP TYPE fixo_session_status;

-- 9. Index for the new sort/filter pattern
CREATE INDEX idx_fixo_sessions_user_last_msg
  ON fixo_sessions (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
