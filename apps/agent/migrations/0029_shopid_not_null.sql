-- Final multi-tenancy step: enforce shop_id NOT NULL.
-- Deferred from 0028 until all write paths stamp shop_id (Phases 1-3:
-- gateway route scoping, create_order routing, chat first-contact stamping).
-- Backfill first catches any row created with a NULL shop_id during the
-- rollout window, then locks the constraint.

BEGIN;

-- Catch stragglers (rows inserted before the stamping code landed) -> san-jose.
-- RAISE NOTICE lets the operator see how many rows get re-tenanted instead of
-- the backfill being silent.
DO $$
BEGIN
  RAISE NOTICE 'backfilling % NULL shop_id rows in customers',
    (SELECT count(*) FROM customers WHERE shop_id IS NULL);
END $$;
UPDATE customers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'backfilling % NULL shop_id rows in orders',
    (SELECT count(*) FROM orders WHERE shop_id IS NULL);
END $$;
UPDATE orders    SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'backfilling % NULL shop_id rows in providers',
    (SELECT count(*) FROM providers WHERE shop_id IS NULL);
END $$;
UPDATE providers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;

-- Enforce.
ALTER TABLE customers ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE orders    ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE providers ALTER COLUMN shop_id SET NOT NULL;

COMMIT;
