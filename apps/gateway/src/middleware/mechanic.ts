import type { Env } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { dbAdmin, schema } from "@hmls/agent/db";
import { type AuthUser, verifyToken } from "../lib/supabase.ts";

/** Env type for mechanic routes. Guarantees `providerId` is set. */
export type MechanicEnv = Env & {
  Variables: {
    authUser: AuthUser;
    providerId: number;
  };
};

/**
 * Two-step gate: (1) JWT must have role `mechanic` or `admin` — that's the
 * authorization decision. (2) Resolve the active providers row linked via
 * `auth_user_id` to populate `providerId` on context for downstream queries.
 *
 * Why not put `provider_id` in the JWT? The RBAC hook would have to read
 * `providers`, which is RLS-protected — solvable with SECURITY DEFINER but
 * that bakes a DB-internal id into a token and couples auth issuance to a
 * mutable shop-data table. Keep the hook trivial (role only); resolve the
 * provider row at request time. One indexed lookup per request.
 */
export const requireMechanic = createMiddleware<MechanicEnv>(async (c, next) => {
  if (Deno.env.get("SKIP_AUTH") === "true") {
    const devProviderId = Number(Deno.env.get("DEV_PROVIDER_ID") ?? "1");
    c.set("authUser", {
      id: "dev-mechanic",
      email: "mechanic@localhost",
      role: "mechanic",
    });
    c.set("providerId", devProviderId);
    await next();
    return;
  }

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Missing authorization header" } },
      401,
    );
  }

  const user = await verifyToken(auth.slice(7));
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
      401,
    );
  }

  if (user.role !== "mechanic" && user.role !== "admin") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Mechanic access required" } },
      403,
    );
  }

  // ponytail: an admin hitting a mechanic route resolves providerId from
  // their OWN providers row below, which may belong to a different shop
  // than shop-context.ts resolves for their admin identity. This can't
  // leak — a shopId/providerId mismatch means downstream RLS-scoped queries
  // match 0 rows (fail-closed), not another shop's data. Revisit only if
  // dual-role admin+mechanic accounts become common enough to need a
  // proper shared shop-resolution path.

  // Identity resolution before any shop scope exists — no tenant GUC set yet.
  // isActive=true: a deactivated (fired) mechanic must resolve to no provider.
  const [row] = await dbAdmin
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(and(eq(schema.providers.authUserId, user.id), eq(schema.providers.isActive, true)))
    .limit(1);

  if (!row) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "No provider profile linked to this account",
        },
      },
      403,
    );
  }

  c.set("authUser", user);
  c.set("providerId", row.id);
  await next();
});
