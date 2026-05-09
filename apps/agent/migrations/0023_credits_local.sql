-- Move Fixo credits from Stripe customer.balance to local DB +
-- prepare schema for future Pro tier + protect against out-of-order webhooks.
--
-- Why: every credit check used to round-trip to Stripe (read + write per
-- chat turn / media upload). That's slow on the hot path, subject to Stripe
-- rate limits, and depends on Stripe being up. Also: the Stripe
-- customer.balance semantic is "money owed", which we were inverting with
-- ceil(balance / -1). Reports/dashboards in Stripe become confusing.
--
-- New model:
--   * Two credit buckets per user, both on user_profiles:
--       - credits_monthly_remaining: granted on subscription period
--         (Plus = 2000) or on free-tier monthly refresh (Free = 200).
--         Unused credits expire when the next grant lands (overwrite, not add).
--       - credits_topup_remaining: bought via one-time Stripe Checkout.
--         Never expire.
--   * Consumption deducts from monthly first, falls through to topup.
--   * credit_ledger records every +/- mutation for audit, debug, and
--     dispute resolution. Hot path doesn't read it.
--
-- Idempotency for Stripe webhooks: stripe_event UNIQUE prevents
-- double-grants when Stripe retries delivery.
--
-- Out-of-order webhook protection: last_subscription_event_at lets
-- subscription.* handlers ignore stale events that arrive after newer ones
-- (Stripe doesn't guarantee delivery order).
--
-- Pro tier: enum extended with 'pro' as a future-ready extension point.
-- No Stripe Product / Price exists yet — webhook treats unknown price IDs
-- gracefully via tierFromPriceId returning null.

BEGIN;

-- 1. Extend tier enum with 'pro' for future use. No-op for existing rows.
--    IF NOT EXISTS makes the migration safely idempotent.
ALTER TYPE user_tier ADD VALUE IF NOT EXISTS 'pro';

-- 2. Credit balance columns on user_profiles + out-of-order webhook guard.
ALTER TABLE public.user_profiles
  ADD COLUMN credits_monthly_remaining integer NOT NULL DEFAULT 0,
  ADD COLUMN credits_topup_remaining   integer NOT NULL DEFAULT 0,
  ADD COLUMN monthly_grant_period_start timestamptz,
  ADD COLUMN last_subscription_event_at timestamptz;

-- Non-negative invariant — we never want to ship code that lets a balance
-- go below zero. DB-level catch protects against bugs.
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_credits_monthly_nonneg
    CHECK (credits_monthly_remaining >= 0),
  ADD CONSTRAINT user_profiles_credits_topup_nonneg
    CHECK (credits_topup_remaining >= 0);

-- 3. Ledger table.
CREATE TABLE public.credit_ledger (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  delta        integer NOT NULL,                    -- positive = grant/topup/refund, negative = consumption
  bucket       text NOT NULL CHECK (bucket IN ('monthly', 'topup')),
  reason       text NOT NULL,                       -- 'subscription_grant' | 'free_monthly_grant' | 'topup_purchase' | 'consumption' | 'refund' | 'admin_adjustment' | 'legacy_migration'
  session_id   integer REFERENCES public.fixo_sessions(id) ON DELETE SET NULL,
  input_type   text,                                -- 'text' | 'obd' | 'photo' | 'audio' | 'video' | 'report'
  stripe_event text,                                -- Stripe event.id for idempotency
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_ledger_user
  ON public.credit_ledger(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_credit_ledger_stripe_event
  ON public.credit_ledger(stripe_event)
  WHERE stripe_event IS NOT NULL;

-- 4. Backfill existing user_profiles with their first monthly grant.
--    Plus subscribers get 2000, Free users get 200. Period start = now,
--    so the next refresh cron will skip them until ~30 days from now.
--    Pro users (none expected yet) would get 6000 if any exist.
UPDATE public.user_profiles
SET
  credits_monthly_remaining = CASE
    WHEN tier = 'pro'  THEN 6000
    WHEN tier = 'plus' THEN 2000
    ELSE 200
  END,
  monthly_grant_period_start = now();

-- Mirror the backfill in the ledger so audit trail starts from a known state.
INSERT INTO public.credit_ledger (user_id, delta, bucket, reason, metadata)
SELECT
  id,
  CASE
    WHEN tier = 'pro'  THEN 6000
    WHEN tier = 'plus' THEN 2000
    ELSE 200
  END,
  'monthly',
  'legacy_migration',
  jsonb_build_object('tier', tier, 'note', 'initial backfill from 0023_credits_local migration')
FROM public.user_profiles;

COMMIT;
