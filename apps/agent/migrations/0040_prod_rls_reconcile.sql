-- 0040: reconcile prod's dashboard-era RLS state before the Phase-2 flip.
-- Discovered by prod inventory (2026-07-08): prod carries RLS state the repo
-- never tracked, and it breaks the 0039 flip in both directions.
--
--   (a) 4 legacy PERMISSIVE policies granted TO public. The customers +
--       pricing_config ones are USING(true) — they admit EVERY role, which
--       (1) exposes the customers table via PostgREST to anon-key holders
--       TODAY (live PII hole) and (2) would void 0039's tenant isolation
--       (permissive policies OR together). Drop them. The gateway's
--       service_role/postgres connections BYPASSRLS and never needed them;
--       the web app uses supabase-js for auth only (no PostgREST data reads).
--
--   (b) 6 NON-tenant tables have RLS enabled (dashboard-era) with no policy
--       visible to tenant_app → the restricted default connection would fail
--       closed on pricing + fixo + profile reads the moment
--       TENANT_DATABASE_URL points at tenant_app. Grant tenant_app full
--       access per table; anon/authenticated stay blocked (no policy for
--       them, RLS stays enabled).
--
-- Idempotent. Apply AFTER 0038 (needs the tenant_app role), BEFORE 0039.
DROP POLICY IF EXISTS "Allow service role full access" ON customers;
DROP POLICY IF EXISTS "Allow service role full access" ON pricing_config;
DROP POLICY IF EXISTS "Admin full access on orders" ON orders;
DROP POLICY IF EXISTS "Customers can view own orders" ON orders;

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'pricing_config', 'fixo_sessions', 'fixo_media',
      'fixo_obd_codes', 'user_profiles', 'vehicles'
    ]
    LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('DROP POLICY IF EXISTS tenant_app_full ON %I', t);
        EXECUTE format(
          'CREATE POLICY tenant_app_full ON %I FOR ALL TO tenant_app USING (true) WITH CHECK (true)',
          t
        );
      END IF;
    END LOOP;
  END IF;
END $$;
