-- Bonus-credits coupon system. Stripe coupons can only do $/% discounts;
-- this table backs codes that grant credits without affecting price
-- (e.g. influencer codes, referral bonuses, beta-tester rewards).
--
-- Redemption flow: user enters code → POST /billing/redeem → server
-- validates (exists, not expired, under max_uses, not already redeemed
-- by this user) → grantTopup with stripe_event="promo:CODE:userId" for
-- idempotency, increments used.

BEGIN;

CREATE TABLE public.promo_codes (
  code         text PRIMARY KEY,
  credits      integer NOT NULL CHECK (credits > 0),
  max_uses     integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses         integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at   timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_codes_uses_le_max CHECK (uses <= max_uses)
);

-- Per-user redemption log so we can prevent the same user from redeeming
-- the same code twice, even if the code has multiple uses left.
CREATE TABLE public.promo_redemptions (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL REFERENCES public.promo_codes(code) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  ledger_id   bigint REFERENCES public.credit_ledger(id) ON DELETE SET NULL,
  UNIQUE (code, user_id)
);

CREATE INDEX idx_promo_redemptions_user
  ON public.promo_redemptions(user_id, redeemed_at DESC);

COMMIT;
