-- 0039: enable RLS on the 7 tenant tables with policies keyed on transaction-
-- local GUCs app.shop_id (staff) / app.customer_id (customer). Idempotent:
-- policies dropped-if-exists then recreated; ENABLE/FORCE are idempotent.
-- ROLLBACK: apply 0039_disable_rls.sql (reverts to app-layer-only in seconds).
-- NOTE: service_role is BYPASSRLS, so dbAdmin still sees everything by design.

-- orders: staff sees own shop; customer sees own orders across any shop.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_tenant ON orders;
CREATE POLICY orders_tenant ON orders FOR ALL
  USING (
    shop_id = nullif(current_setting('app.shop_id', true), '')::uuid
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::int
  )
  WITH CHECK (
    shop_id = nullif(current_setting('app.shop_id', true), '')::uuid
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::int
  );

-- customers: staff sees own-shop customers; a customer sees own row.
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customers_tenant ON customers;
CREATE POLICY customers_tenant ON customers FOR ALL
  USING (
    shop_id = nullif(current_setting('app.shop_id', true), '')::uuid
    OR id = nullif(current_setting('app.customer_id', true), '')::int
  )
  WITH CHECK (
    shop_id = nullif(current_setting('app.shop_id', true), '')::uuid
    OR id = nullif(current_setting('app.customer_id', true), '')::int
  );

-- providers: shop-scoped only.
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS providers_tenant ON providers;
CREATE POLICY providers_tenant ON providers FOR ALL
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- order_intake / order_events → orders (parent visibility; inner select is
-- itself RLS-filtered by the orders policy).
ALTER TABLE order_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_intake FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_intake_tenant ON order_intake;
CREATE POLICY order_intake_tenant ON order_intake FOR ALL
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_intake.order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_intake.order_id));

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_events_tenant ON order_events;
CREATE POLICY order_events_tenant ON order_events FOR ALL
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_events.order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_events.order_id));

-- provider_availability / provider_schedule_overrides → providers.
ALTER TABLE provider_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_availability FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_availability_tenant ON provider_availability;
CREATE POLICY provider_availability_tenant ON provider_availability FOR ALL
  USING (EXISTS (SELECT 1 FROM providers p WHERE p.id = provider_availability.provider_id))
  WITH CHECK (EXISTS (SELECT 1 FROM providers p WHERE p.id = provider_availability.provider_id));

ALTER TABLE provider_schedule_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_schedule_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_schedule_overrides_tenant ON provider_schedule_overrides;
CREATE POLICY provider_schedule_overrides_tenant ON provider_schedule_overrides FOR ALL
  USING (EXISTS (SELECT 1 FROM providers p WHERE p.id = provider_schedule_overrides.provider_id))
  WITH CHECK (EXISTS (SELECT 1 FROM providers p WHERE p.id = provider_schedule_overrides.provider_id));

-- ── auth-hook carve-out (found by local full-stack test, 2026-07-08) ─────────
-- custom_access_token_hook runs as supabase_auth_admin (NOT SECURITY DEFINER,
-- NOT BYPASSRLS — verified in prod). Under FORCE RLS its
-- `SELECT role FROM customers WHERE auth_user_id = ...` matches no policy
-- (no GUC is set at token issuance) → 0 rows → every login is minted
-- user_role='customer' → all admins/owners are locked out of /admin.
-- Per-role read policy fixes exactly that path and nothing else.
-- (handle_new_user is unaffected: SECURITY DEFINER, owner postgres = BYPASSRLS.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    DROP POLICY IF EXISTS customers_auth_hook_read ON customers;
    CREATE POLICY customers_auth_hook_read ON customers
      FOR SELECT TO supabase_auth_admin USING (true);
  END IF;
END $$;
