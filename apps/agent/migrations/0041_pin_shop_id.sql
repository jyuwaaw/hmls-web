-- 0041: pin shop_id against a customer-scoped UPDATE via column-level GRANT.
--
-- orders_tenant / customers_tenant (0039) OR a shop-branch and a customer-
-- branch in both USING and WITH CHECK. A customer-scoped transaction (only
-- app.customer_id set, app.shop_id unset) can UPDATE its own row and set
-- shop_id to ANY value: WITH CHECK's customer_id branch still matches (the
-- customer_id didn't change), so the row passes even though shop_id moved.
-- WITH CHECK cannot reference OLD, so RLS alone can't pin the column.
--
-- Fix: strip tenant_app's UPDATE on orders/customers down to "every column
-- except shop_id". Only dbAdmin (service_role, BYPASSRLS) may write shop_id,
-- which is exactly the one legitimate cross-shop write path (first-order shop
-- claiming in create_order, apps/agent/src/common/tools/order.ts:920) —
-- already on dbAdmin; verified no other tenant-path UPDATE touches shop_id
-- on orders or customers.
--
-- NOTE: a plain `REVOKE UPDATE (shop_id) ... FROM tenant_app` does NOT work
-- here — 0038 granted UPDATE at the TABLE level ("GRANT UPDATE ON ALL
-- TABLES"), and Postgres ORs table-level and column-level ACLs for a
-- permission check, so a column-level REVOKE can't subtract from a
-- table-level GRANT (verified empirically against local Supabase: the naive
-- REVOKE left `UPDATE orders SET shop_id = shop_id` still permitted as
-- tenant_app). The only way to pin one column is to revoke the table-level
-- UPDATE entirely and re-grant it column-by-column, omitting shop_id.
--
-- ponytail: this means any FUTURE column added to orders/customers needs its
-- own `GRANT UPDATE (col) ON <table> TO tenant_app` (table-wide UPDATE is
-- intentionally gone for these two tables) — add one when the column ships,
-- or re-run this migration (it's idempotent and re-derives the column list
-- from the catalog, so it picks up new columns automatically minus shop_id).
DO $$
DECLARE
  cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_app') THEN
    RETURN;
  END IF;

  REVOKE UPDATE ON orders FROM tenant_app;
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name <> 'shop_id';
  IF cols IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%s) ON orders TO tenant_app', cols);
  END IF;

  REVOKE UPDATE ON customers FROM tenant_app;
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name <> 'shop_id';
  IF cols IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%s) ON customers TO tenant_app', cols);
  END IF;
END $$;
