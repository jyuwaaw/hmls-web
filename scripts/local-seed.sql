-- Local-dev seed: the DB objects drizzle-kit push CANNOT produce, plus reference
-- data. Applied by scripts/db-local-reset.sh AFTER `db:push` builds the tables
-- from packages/shared/src/db/schema.ts. Idempotent — safe to re-run.
--
-- Source of truth for these objects is still apps/agent/migrations/*.sql (prod).
-- When you add/alter a function/trigger/constraint there, mirror it here.

-- ── functions (CREATE OR REPLACE = idempotent) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_abandoned_drafts(stale_days integer DEFAULT 14) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  cancelled_count INTEGER;
  cutoff TIMESTAMPTZ := now() - make_interval(days => stale_days);
  reason TEXT := format('abandoned (no activity for %s days)', stale_days);
  now_ts TIMESTAMPTZ := now();
  now_iso TEXT := to_char(now_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  WITH updated AS (
    UPDATE orders
    SET status = 'cancelled',
        cancellation_reason = reason,
        status_history = status_history || jsonb_build_array(
          jsonb_build_object('status', 'cancelled', 'timestamp', now_iso, 'actor', 'system:abandoned-cleanup')
        ),
        updated_at = now_ts
    WHERE status = 'draft' AND scheduled_at IS NULL AND updated_at < cutoff
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

CREATE OR REPLACE FUNCTION public.compute_blocked_range() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  claims jsonb;
  v_user_id text;
  v_role text;
BEGIN
  v_user_id := event->>'user_id';
  claims := event->'claims';
  SELECT role INTO v_role FROM public.customers WHERE auth_user_id = v_user_id LIMIT 1;
  IF v_role IS NULL OR v_role = 'customer' THEN
    SELECT COALESCE(raw_app_meta_data->>'role', v_role) INTO v_role
    FROM auth.users WHERE id::text = v_user_id LIMIT 1;
  END IF;
  IF v_role IS NULL THEN v_role := 'customer'; END IF;
  claims := jsonb_set(claims, '{user_role}', to_jsonb(v_role));
  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _name TEXT;
  _phone TEXT;
  _email TEXT;
  _shop_id uuid;
BEGIN
  _email := NEW.email;
  _name := NEW.raw_user_meta_data ->> 'full_name';
  IF _name IS NULL THEN _name := NEW.raw_user_meta_data ->> 'name'; END IF;
  _phone := NEW.raw_user_meta_data ->> 'phone';

  UPDATE public.customers SET auth_user_id = NEW.id::text
  WHERE email = _email AND auth_user_id IS NULL;

  IF NOT FOUND THEN
    SELECT COALESCE(
      (SELECT id FROM public.shops WHERE slug = 'san-jose'),
      (SELECT id FROM public.shops ORDER BY created_at LIMIT 1)
    ) INTO _shop_id;
    INSERT INTO public.customers (name, email, phone, auth_user_id, shop_id)
    VALUES (_name, _email, _phone, NEW.id::text, _shop_id);
  END IF;
  RETURN NEW;
END;
$$;

-- ── triggers (drop+create = idempotent) ─────────────────────────────────────
DROP TRIGGER IF EXISTS trg_orders_compute_blocked_range ON public.orders;
CREATE TRIGGER trg_orders_compute_blocked_range
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.compute_blocked_range();

-- New-signup → customer row. Lives on auth.users (outside drizzle's reach).
-- Guarded so this seed also runs on a plain Postgres (CI) with no auth schema.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

-- GoTrue calls the custom_access_token hook as supabase_auth_admin. The function
-- is STABLE (not SECURITY DEFINER), so it runs with that role's privileges and
-- must be able to read public.customers — EXECUTE alone makes login 500. Guarded:
-- the role only exists in Supabase.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
    GRANT SELECT ON public.customers TO supabase_auth_admin;
  END IF;
END $$;

-- ponytail: prod has an EXCLUDE no-overlap on provider_availability, skipped
-- locally. It needs `time` columns (a gist tsrange), but schema.ts deliberately
-- types start_time/end_time as varchar (see its line-81 comment), and casting
-- varchar→time isn't IMMUTABLE so it can't live in an index expression. No test
-- needs it and local dev never bulk-enters availability. Add it back here if a
-- local test ever exercises overlap rejection.

-- ── reference data (required for the app to run) ─────────────────────────────
INSERT INTO public.shops (id, name, slug, timezone, labor_rate_cents, tax_rate_percent, created_at, latitude, longitude) VALUES
  ('086ada9b-3023-48ff-9144-808daee319d6', 'HMLS Mobile Mechanic — San Jose', 'san-jose', 'America/Los_Angeles', 14000, 0, '2026-06-18 04:15:55.253626+00', 37.3361663, -121.8905910),
  ('3f47fb6c-4d48-4a44-8c8c-f4da1f8575fc', 'HMLS Mobile Mechanic — Orange County', 'orange-county', 'America/Los_Angeles', 14000, 0, '2026-06-18 04:15:55.253626+00', 33.6484505, -117.8365716)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pricing_config (key, value, description) VALUES
  ('diagnostic_fee', '9500', 'Base diagnostic fee in cents ($95)'),
  ('after_hours_fee', '5000', 'After-hours service fee in cents ($50) - evenings 6pm-10pm'),
  ('rush_fee', '7500', 'Same-day rush service fee in cents ($75)'),
  ('weekend_fee', '3500', 'Weekend service fee in cents ($35) - Saturday service'),
  ('sunday_fee', '5000', 'Sunday service fee in cents ($50)'),
  ('holiday_fee', '10000', 'Holiday service fee in cents ($100)'),
  ('early_morning_fee', '2500', 'Early morning fee in cents ($25) - before 8am'),
  ('base_travel_miles', '15', 'Miles included in base price (no extra charge)'),
  ('per_mile_fee', '100', 'Fee per mile beyond base travel in cents ($1.00/mile)'),
  ('minimum_service_fee', '7500', 'Minimum service charge in cents ($75)'),
  ('parts_markup_tier2_pct', '30', 'Parts markup % for items $50-$200'),
  ('parts_markup_tier3_pct', '20', 'Parts markup % for items over $200'),
  ('parts_markup_tier4_pct', '15', 'Parts markup % for items over $500'),
  ('multi_service_discount_pct', '10', 'Discount % for 3+ services in one visit'),
  ('returning_customer_discount_pct', '5', 'Discount % for returning customers'),
  ('referral_discount_pct', '10', 'Discount % for referred customers'),
  ('fleet_discount_pct', '15', 'Discount % for fleet accounts (5+ vehicles)'),
  ('senior_discount_pct', '10', 'Senior discount % (65+)'),
  ('military_discount_pct', '10', 'Military/veteran discount %'),
  ('first_responder_discount_pct', '10', 'First responder discount %'),
  ('tire_disposal_fee', '500', 'Tire disposal fee per tire in cents ($5)'),
  ('battery_core_charge', '2500', 'Battery core charge if old not returned in cents ($25)'),
  ('no_show_fee', '5000', 'No-show/late cancellation fee in cents ($50)'),
  ('hourly_rate', '14000', 'Base hourly labor rate in cents ($140/hr)'),
  ('hazmat_disposal_fee', '800', 'Hazardous material disposal fee in cents ($15)'),
  ('parts_markup_tier1_pct', '40', 'Parts markup % for items under $50')
ON CONFLICT (key) DO NOTHING;
