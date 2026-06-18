-- Multi-tenancy foundation.
--   1. shops gets geo + radius columns
--   2. providers gets shop_id
--   3. create the first two shop rows (table is empty as of 2026-06-17):
--      san-jose (primary / backfill target) + orange-county
--   4. backfill all existing customers/orders/providers -> san-jose
--   5. scoping indexes
-- shop_id stays NULLABLE here. NOT NULL is enforced in a later migration (0029)
-- once every write path stamps shop_id (Phases 1-3). The backfill below still
-- makes all existing rows non-null immediately.
-- Seed labor_rate_cents = 14000 ($140/hr) = current global hourly_rate, so
-- per-shop pricing is a no-op on existing orders.

BEGIN;

-- 1. shops geo + radius
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS service_radius_km integer;

-- 2. providers.shop_id (nullable now; NOT NULL after backfill)
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES shops(id);

-- 3. seed the two shops
INSERT INTO shops (name, slug, timezone, labor_rate_cents, tax_rate_percent, latitude, longitude)
SELECT 'HMLS Mobile Mechanic — San Jose', 'san-jose', 'America/Los_Angeles', 14000, '0.0000', 37.3361663, -121.890591
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE slug = 'san-jose');

INSERT INTO shops (name, slug, timezone, labor_rate_cents, tax_rate_percent, latitude, longitude)
SELECT 'HMLS Mobile Mechanic — Orange County', 'orange-county', 'America/Los_Angeles', 14000, '0.0000', 33.6484505, -117.8365716
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE slug = 'orange-county');

-- 4. backfill everything to San Jose (the primary)
UPDATE customers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;
UPDATE orders    SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;
UPDATE providers SET shop_id = (SELECT id FROM shops WHERE slug = 'san-jose' LIMIT 1) WHERE shop_id IS NULL;

-- 5. scoping indexes
CREATE INDEX IF NOT EXISTS customers_shop_id_idx ON customers (shop_id);
CREATE INDEX IF NOT EXISTS providers_shop_id_idx ON providers (shop_id);
CREATE INDEX IF NOT EXISTS orders_shop_status_idx ON orders (shop_id, status);

COMMIT;
