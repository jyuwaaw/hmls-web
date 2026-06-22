import type { Env } from "hono";
import { createMiddleware } from "hono/factory";
import { withContext } from "@logtape/logtape";
import { type AuthUser, verifyToken } from "../lib/supabase.ts";

/** Env type for admin routes. */
export type AdminEnv = Env & {
  Variables: {
    authUser: AuthUser;
  };
};

/**
 * Requires a valid JWT with admin role in app_metadata.
 * No DB query — checks the JWT claim directly.
 * Returns 401 if missing/invalid token, 403 if not admin.
 */
export const requireAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  // Dev bypass: SKIP_AUTH=true skips all auth checks locally
  if (Deno.env.get("SKIP_AUTH") === "true") {
    const devUser = { id: "dev", email: "dev@localhost", role: "admin" as const };
    c.set("authUser", devUser);
    await withContext({ userId: devUser.id, role: "admin" }, next);
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

  if (user.role !== "admin" && user.role !== "owner") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Admin access required" } },
      403,
    );
  }

  c.set("authUser", user);
  await withContext({ userId: user.id, role: user.role }, next);
});
