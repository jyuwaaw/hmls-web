import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

// ALS carries the current DB executor (a scoped transaction, or the admin
// client) for the duration of a request/tool unit. When set, the `db` proxy
// routes to it; when unset, `db` uses the base tenant pool — which, under RLS
// with no GUC set, denies tenant-table access (fail-closed).
// deno-lint-ignore no-explicit-any
type Executor = any;
const txStore = new AsyncLocalStorage<{ executor: Executor }>();

// Logged at most once per process — see the fallback branch in tenantDb().
let warnedTenantFallback = false;

/** Decide which GUC a scoped transaction must set. Pure — unit tested.
 *  Customer identity wins (a customer sees own rows across shops); otherwise a
 *  concrete shopId scopes to that shop. Owner-all is NOT handled here — callers
 *  route owner-wide reads through withAdminScope. */
export function pickScopeConfig(
  ctx: { shopId?: string; customerId?: number },
): { setting: "app.customer_id" | "app.shop_id"; value: string } {
  if (ctx.customerId != null) {
    return { setting: "app.customer_id", value: String(ctx.customerId) };
  }
  if (ctx.shopId) return { setting: "app.shop_id", value: ctx.shopId };
  throw new Error("withTenantScope: no customerId or shopId in context (fail-closed)");
}

/**
 * Create the tenant + admin DB clients and the scope helpers.
 * Each app passes its own schema for type-safe queries.
 */
export function createDbClient<T extends Record<string, unknown>>(schema: T) {
  let _tenant: ReturnType<typeof drizzle<T>> | null = null;
  let _admin: ReturnType<typeof drizzle<T>> | null = null;

  function tenantDb() {
    if (!_tenant) {
      // Prefer the restricted role; fall back to service_role in envs where
      // TENANT_DATABASE_URL isn't provisioned (local dev / CI / local-Supabase
      // tests). A deployed env missing TENANT_DATABASE_URL is caught by the
      // boot guard in apps/gateway/src/index.ts — this fallback existing here
      // too is belt-and-suspenders for any other entrypoint.
      const tenantUrl = Deno.env.get("TENANT_DATABASE_URL");
      const url = tenantUrl ?? Deno.env.get("DATABASE_URL");
      if (!url) {
        throw new Error("TENANT_DATABASE_URL/DATABASE_URL environment variable is required");
      }
      if (!tenantUrl && !warnedTenantFallback) {
        warnedTenantFallback = true;
        console.warn(
          "[db] tenant client falling back to DATABASE_URL — RLS not enforced at the app " +
            "layer (expected only in local/dev/CI)",
        );
      }
      // deno-lint-ignore no-explicit-any
      _tenant = drizzle(postgres(url) as any, { schema });
    }
    return _tenant;
  }
  function adminDb() {
    if (!_admin) {
      const url = Deno.env.get("DATABASE_URL");
      if (!url) throw new Error("DATABASE_URL environment variable is required");
      // deno-lint-ignore no-explicit-any
      _admin = drizzle(postgres(url) as any, { schema });
    }
    return _admin;
  }

  function proxy(pick: () => ReturnType<typeof drizzle<T>>) {
    return new Proxy({} as ReturnType<typeof drizzle<T>>, {
      get(_t, prop) {
        const target = pick();
        const value = target[prop as keyof typeof target];
        // deno-lint-ignore no-explicit-any
        return typeof value === "function" ? (value as any).bind(target) : value;
      },
    });
  }

  // Default: ALS executor wins; else base tenant pool (fail-closed under RLS).
  const db = proxy(
    () => (txStore.getStore()?.executor as ReturnType<typeof drizzle<T>>) ?? tenantDb(),
  );
  // Admin: ALWAYS service_role, ignoring ALS. Bootstrap/system/owner-all/public-token.
  const dbAdmin = proxy(() => adminDb());

  /** Run `fn` inside a short transaction with the tenant GUC set (is_local,
   *  reset at COMMIT). All `db.x` inside `fn` transparently use this tx. */
  async function withTenantScope<R>(
    ctx: { shopId?: string; customerId?: number },
    fn: () => Promise<R>,
  ): Promise<R> {
    const { setting, value } = pickScopeConfig(ctx);
    return await tenantDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config(${setting}, ${value}, true)`);
      return await txStore.run({ executor: tx }, fn);
    });
  }

  /** Run `fn` bound to the admin (service_role) client — cross-tenant (owner-all)
   *  and explicitly-privileged/bootstrap paths. No RLS. */
  async function withAdminScope<R>(fn: () => Promise<R>): Promise<R> {
    return await txStore.run({ executor: adminDb() }, fn);
  }

  /** Best-effort boot check: confirm the tenant connection is NOT superuser/
   *  BYPASSRLS. Deployed-only callers should invoke this after boot; a failed
   *  query only logs (never throws) — a transient DB blip at boot shouldn't
   *  crash the app. The hard gate for a missing TENANT_DATABASE_URL is the
   *  env guard in apps/gateway/src/index.ts, not this check. */
  async function assertTenantRole(): Promise<void> {
    try {
      const rows = await tenantDb().execute(sql`
        select current_setting('is_superuser') as su,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypass
      `);
      const row = (rows as unknown as Array<{ su: string; bypass: boolean }>)[0];
      if (!row) return;
      const isSuperuser = row.su === "on";
      if (isSuperuser || row.bypass) {
        console.error(
          "[db] ALARM: tenant DB role is " +
            `${isSuperuser ? "superuser" : ""}${isSuperuser && row.bypass ? "+" : ""}` +
            `${row.bypass ? "BYPASSRLS" : ""} — RLS is not enforced for the tenant connection`,
        );
      }
    } catch (err) {
      console.error("[db] tenant role check failed (non-fatal):", err);
    }
  }

  return { db, dbAdmin, withTenantScope, withAdminScope, assertTenantRole };
}
