-- Backfill orphan orders + lock orders.customer_id to NOT NULL.
--
-- Migration 0001 declared customer_id NOT NULL but the constraint was lost
-- somewhere along the way (likely during a column reshuffle). 8 dev rows
-- ended up with NULL — a mix of abandoned drafts/cancellations from chat
-- flows that never resolved a customer, plus two real completed walk-ins
-- (Blade, Dave) that admin recorded with contact info but never linked.
--
-- This migration:
--   1. Inserts a synthetic "Walk-in (unlinked)" placeholder customer if it
--      doesn't already exist. Marker: email = 'walkin-unlinked@hmls.local'
--      (a domain we don't own, so no risk of collision with real users).
--   2. Re-points every NULL-customer order at that placeholder.
--   3. Adds the NOT NULL constraint to align with schema.ts.
--
-- Admin can later split the two real walk-in orders (Blade, Dave) out into
-- proper customer records — not this migration's concern.

BEGIN;

-- 1. Idempotent placeholder customer
INSERT INTO customers (name, email, role)
SELECT 'Walk-in (unlinked)', 'walkin-unlinked@hmls.local', 'customer'::user_role
WHERE NOT EXISTS (
  SELECT 1 FROM customers WHERE email = 'walkin-unlinked@hmls.local'
);

-- 2. Backfill orphans
UPDATE orders
SET customer_id = (
  SELECT id FROM customers WHERE email = 'walkin-unlinked@hmls.local' LIMIT 1
)
WHERE customer_id IS NULL;

-- 3. Lock the column. Will fail loudly if step 2 missed any row.
ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;

COMMIT;
