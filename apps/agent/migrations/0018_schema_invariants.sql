-- Schema invariants & dead-field cleanup.
--
-- This migration tightens DB-level guarantees that the app has implicitly
-- relied on, drops fields that no code reads, and renames a misleading
-- payment column. Specifically:
--
--   1. orders.share_token: add UNIQUE (was only indexed; the lazy backfill
--      in routes/orders.ts could in theory write a colliding token).
--   2. Enums for orders.status, order_events.event_type, orders.payment_method,
--      customers.role — replaces free-form varchars so the DB rejects garbage
--      writes.
--   3. provider_availability: EXCLUDE constraint preventing overlapping
--      time ranges per (provider_id, day_of_week). Behavioral bug today —
--      scheduling.ts builds a Map keyed on (providerId, dayOfWeek) and the
--      second row silently overwrites the first.
--   4. provider_schedule_overrides: UNIQUE (provider_id, override_date).
--      Same Map.set overwrite issue.
--   5. compute_blocked_range trigger: only recompute scheduling fields when
--      scheduled_at / duration_minutes actually change. Still bumps
--      updated_at on every UPDATE so auto-cancel-abandoned-drafts cron
--      keeps working.
--   6. providers: drop specialties / service_radius_miles / home_base_lat /
--      home_base_lng — written by admin form but never read by any
--      dispatch / scheduling code.
--   7. orders: rename captured_amount_cents → paid_amount_cents. The Stripe
--      "captured" semantics no longer apply now that payment is manual.

BEGIN;

-- 1. share_token UNIQUE
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_share_token_uniq;
ALTER TABLE orders ADD CONSTRAINT orders_share_token_uniq UNIQUE (share_token);

-- 2. Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM (
      'draft','estimated','revised','approved','declined',
      'scheduled','in_progress','completed','cancelled'
    );
  END IF;
END$$;

ALTER TABLE orders
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE order_status USING status::order_status,
  ALTER COLUMN status SET DEFAULT 'draft'::order_status;

-- Normalize legacy event_type values before locking the column to an enum.
--   * 'items_modified' is a typo of the canonical 'items_edited' (2 rows in dev).
--   * 'contact_edited' is a historical event that no current code path writes,
--     but 13 dev rows carry it — keep it as a valid enum value so the cast
--     succeeds and the audit log stays truthful (UI's default branch already
--     formats unrecognized event types).
UPDATE order_events SET event_type = 'items_edited'
  WHERE event_type = 'items_modified';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_event_type') THEN
    CREATE TYPE order_event_type AS ENUM (
      'status_change','items_edited','schedule_attached',
      'provider_assigned','payment_recorded','note_added',
      'contact_edited'
    );
  END IF;
END$$;

ALTER TABLE order_events
  ALTER COLUMN event_type TYPE order_event_type USING event_type::order_event_type;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN
    CREATE TYPE payment_method AS ENUM (
      'cash','card','check','venmo','zelle','stripe','other'
    );
  END IF;
END$$;

ALTER TABLE orders
  ALTER COLUMN payment_method TYPE payment_method USING payment_method::payment_method;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('customer','admin','mechanic');
  END IF;
END$$;

ALTER TABLE customers
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE user_role USING role::user_role,
  ALTER COLUMN role SET DEFAULT 'customer'::user_role;

-- 3. provider_availability: no overlap per (provider_id, day_of_week)
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE provider_availability
  DROP CONSTRAINT IF EXISTS provider_availability_no_overlap;

ALTER TABLE provider_availability
  ADD CONSTRAINT provider_availability_no_overlap
  EXCLUDE USING gist (
    provider_id WITH =,
    day_of_week WITH =,
    tsrange(
      ('2000-01-01'::date + start_time::time)::timestamp,
      ('2000-01-01'::date + end_time::time)::timestamp
    ) WITH &&
  );

-- 4. provider_schedule_overrides: unique per (provider_id, override_date)
ALTER TABLE provider_schedule_overrides
  DROP CONSTRAINT IF EXISTS provider_schedule_overrides_provider_date_uniq;

ALTER TABLE provider_schedule_overrides
  ADD CONSTRAINT provider_schedule_overrides_provider_date_uniq
  UNIQUE (provider_id, override_date);

-- 5. compute_blocked_range: skip recompute when scheduling inputs unchanged
CREATE OR REPLACE FUNCTION public.compute_blocked_range()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes THEN
    IF NEW.scheduled_at IS NOT NULL AND NEW.duration_minutes IS NOT NULL THEN
      NEW.appointment_end := NEW.scheduled_at + make_interval(mins => NEW.duration_minutes);
      NEW.blocked_range  := tstzrange(NEW.scheduled_at, NEW.appointment_end, '[)');
    ELSE
      NEW.appointment_end := NULL;
      NEW.blocked_range  := NULL;
    END IF;
  END IF;
  -- Always bump updated_at so auto-cancel-abandoned-drafts (0017) sees
  -- recent activity for any column edit, not just scheduling changes.
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- 6. Drop dead provider columns
ALTER TABLE providers
  DROP COLUMN IF EXISTS specialties,
  DROP COLUMN IF EXISTS service_radius_miles,
  DROP COLUMN IF EXISTS home_base_lat,
  DROP COLUMN IF EXISTS home_base_lng;

-- 7. Rename captured_amount_cents → paid_amount_cents
ALTER TABLE orders RENAME COLUMN captured_amount_cents TO paid_amount_cents;

COMMIT;
