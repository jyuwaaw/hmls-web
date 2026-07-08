import { getLogger } from "@logtape/logtape";
import { assertTenantRole, dbAdmin } from "@hmls/agent/db";
import { sql } from "drizzle-orm";
import { createHmlsApp } from "./hmls-app.ts";
import { createFixoApp } from "./fixo-app.ts";
import { setupLogging } from "./logger.ts";

await setupLogging();
const serverLogger = getLogger(["hmls", "gateway", "server"]);

// ── Fail fast on required env vars ──
const DATABASE_URL = Deno.env.get("DATABASE_URL");
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY");
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required but not set");
}
if (!GOOGLE_API_KEY) {
  throw new Error("GOOGLE_API_KEY is required but not set");
}
if (!DEEPSEEK_API_KEY) {
  throw new Error("DEEPSEEK_API_KEY is required but not set");
}
if (isDenoDeploy && Deno.env.get("SKIP_AUTH") === "true") {
  // SKIP_AUTH bypasses every auth middleware (see auth.ts / mechanic.ts /
  // shop-context.ts) for local dev only. Never let it reach a deployment.
  throw new Error("SKIP_AUTH must never be set in a deployed environment");
}
if (isDenoDeploy && !Deno.env.get("TENANT_DATABASE_URL")) {
  // Without it, packages/shared/src/db/client.ts's tenantDb() falls back to
  // DATABASE_URL — the BYPASSRLS service_role connection — and RLS is
  // silently defeated for every tenant-scoped query. Fine in local/CI
  // (see client.ts's warn-once fallback); never fine on a deployment.
  throw new Error(
    "TENANT_DATABASE_URL is required in a deployed environment — without it the default db " +
      "falls back to the BYPASSRLS service_role and RLS is silently defeated",
  );
}

// Warn on optional vars
for (
  const key of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
  ]
) {
  if (!Deno.env.get(key)) {
    serverLogger.warn(`Optional env var {key} is not set`, { key });
  }
}

const mainApp = createHmlsApp();
const fixoApp = createFixoApp();

// ── Subdomain dispatch ──
const FIXO_HOSTS = ["api.fixo.hmls.autos", "api.fixo.ink", "fixo.localhost"];

function handler(request: Request): Response | Promise<Response> {
  const host = (request.headers.get("host") ?? "").split(":")[0];
  if (FIXO_HOSTS.includes(host)) {
    return fixoApp.fetch(request);
  }

  // Path-based routing: /fixo/* → fixo app (strip prefix)
  const url = new URL(request.url);
  if (url.pathname === "/fixo" || url.pathname.startsWith("/fixo/")) {
    const newPath = url.pathname.slice("/fixo".length) || "/";
    const newUrl = new URL(newPath + url.search, url.origin);
    return fixoApp.fetch(new Request(newUrl, request));
  }

  return mainApp.fetch(request);
}

// Start server
if (isDenoDeploy) {
  if (Deno.env.get("TENANT_DATABASE_URL")) {
    // Best-effort post-boot check that the tenant role isn't superuser/
    // BYPASSRLS (RLS would be silently defeated). Fire-and-forget: never
    // blocks boot, and assertTenantRole() catches its own errors — a
    // transient DB blip here shouldn't crash the app. The hard gate for a
    // missing TENANT_DATABASE_URL is the env guard above.
    void assertTenantRole();
  }
  // Daily reap of abandoned draft orders. Replaces the pg_cron job from
  // migration 0017, which never applied (pg_cron isn't installed on Supabase).
  // Deploy-only on purpose: local dev points at the prod DB, so we never reap
  // from a laptop. The actual cancel logic lives in the `cancel_abandoned_drafts`
  // SQL function (migration 0034).
  // Uses dbAdmin (service_role, bypasses RLS): this is a system job reaping
  // abandoned drafts across ALL shops, and it runs with no tenant GUC set, so
  // the bare `db` would match 0 rows once fail-closed RLS is enabled.
  Deno.cron("cancel-abandoned-drafts", "0 3 * * *", async () => {
    try {
      const rows = await dbAdmin.execute(sql`SELECT cancel_abandoned_drafts(14) AS n`);
      const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
      serverLogger.info("cancel-abandoned-drafts: cancelled {n} order(s)", { n });
    } catch (err) {
      serverLogger.error("cancel-abandoned-drafts cron failed: {err}", { err });
    }
  });
  Deno.serve(handler);
  serverLogger.info("HMLS API running on Deno Deploy");
} else {
  const port = Number(Deno.env.get("HTTP_PORT")) || 8080;
  Deno.serve({ port }, handler);
  serverLogger.info(`HMLS API running on http://localhost:{port}`, { port });
  serverLogger.info(`Fixo API available at http://fixo.localhost:{port}`, { port });
}
