-- Layer 4 PR A: extract `order_intake` from `orders`.
--
-- Rationale: `symptom_description`, `photo_urls`, `customer_notes` are
-- customer-submitted intake — they exist only when the customer flowed
-- through chat with the AI agent. Walk-in admin orders, repeat-customer
-- routine maintenance, and `/admin/orders/new` direct creation NEVER
-- produce these fields, so today they sit as NULL on the majority of
-- order rows and muddle the semantics of `orders` (is NULL "no chat" or
-- "chat happened but customer didn't say"?).
--
-- After this migration:
--   * `order_intake` is a 1:1 child of `orders` (PK = order_id, ON DELETE
--     CASCADE). A row exists iff the customer actually submitted intake.
--   * `orders` loses the 3 columns; semantically clean as
--     "shop-managed order state".
--   * Existing orders with any of the 3 fields populated get a
--     corresponding `order_intake` row. Orders with all 3 NULL get nothing.

BEGIN;

-- 1. Create order_intake (1:1 with orders, PK doubles as the FK)
CREATE TABLE IF NOT EXISTS order_intake (
  order_id            INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  symptom_description TEXT,
  photo_urls          JSONB,
  customer_notes      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Backfill: only orders with at least one intake field set get a row.
INSERT INTO order_intake (order_id, symptom_description, photo_urls, customer_notes)
SELECT id, symptom_description, photo_urls, customer_notes
FROM orders
WHERE symptom_description IS NOT NULL
   OR photo_urls IS NOT NULL
   OR customer_notes IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;

-- 3. Drop the moved columns from orders
ALTER TABLE orders
  DROP COLUMN IF EXISTS symptom_description,
  DROP COLUMN IF EXISTS photo_urls,
  DROP COLUMN IF EXISTS customer_notes;

COMMIT;
