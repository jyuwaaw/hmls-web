import type { Env } from "hono";
import { createMiddleware } from "hono/factory";
import { withContext } from "@logtape/logtape";
import { type AuthUser, verifyToken } from "../lib/supabase.ts";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";

/** Env type for routes that require authentication. */
export type AuthEnv = Env & {
  Variables: {
    authUser: AuthUser;
    customerId: number;
  };
};

/** Env type for routes with optional authentication. */
export type OptionalAuthEnv = Env & {
  Variables: {
    authUser?: AuthUser;
  };
};

/**
 * Requires a valid JWT. Sets `authUser` (id, email) and `customerId` on context.
 * Returns 401 if missing/invalid token, 403 if no customer record found.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  // Dev bypass: SKIP_AUTH=true uses a fixed test customer (id from
  // DEV_CUSTOMER_ID, defaults to 1). Mirrors the admin/mechanic bypass.
  if (Deno.env.get("SKIP_AUTH") === "true") {
    const devCustomerId = Number(Deno.env.get("DEV_CUSTOMER_ID") ?? "1");
    const devUser: AuthUser = {
      id: "dev-customer",
      email: "customer@localhost",
      role: "customer",
    };
    c.set("authUser", devUser);
    c.set("customerId", devCustomerId);
    await withContext({ userId: devUser.id, customerId: devCustomerId }, next);
    return;
  }

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Missing authorization header" } },
      401,
    );
  }

  const token = auth.slice(7);
  const user = await verifyToken(token);
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
      401,
    );
  }

  let [customer] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.authUserId, user.id))
    .limit(1);
  if (!customer && user.email) {
    // Email fallback: only bind when EXACTLY ONE row matches — avoids cross-shop
    // mis-binding when multiple shops have a customer with the same address.
    const emailMatches = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.email, user.email))
      .limit(2);
    if (emailMatches.length === 1) {
      customer = emailMatches[0];
      // Self-heal: stamp auth_user_id so the fallback is not needed next time.
      await db
        .update(schema.customers)
        .set({ authUserId: user.id })
        .where(eq(schema.customers.id, customer.id));
    }
    // 0 or ≥2 matches → treat as not-found (falls through to 403 below).
  }

  if (!customer) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "No customer account found" } },
      403,
    );
  }

  c.set("authUser", user);
  c.set("customerId", customer.id);
  await withContext({ userId: user.id, customerId: customer.id }, next);
});

/**
 * Extracts and verifies JWT if present, but allows anonymous access.
 * Sets `authUser` on context when a valid token is provided.
 */
export const optionalAuth = createMiddleware<OptionalAuthEnv>(async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const user = await verifyToken(token);
    if (user) {
      c.set("authUser", user);
      await withContext({ userId: user.id }, next);
      return;
    }
  }
  await next();
});

/**
 * Env type for routes that require a signed-in user but manage their own
 * customer record (e.g. upsert-on-first-contact).
 */
export type AuthUserEnv = Env & {
  Variables: {
    authUser: AuthUser;
  };
};

/**
 * Requires a valid JWT but does NOT require a pre-existing customer row.
 * Use for routes whose handler creates or upserts the customer inline
 * (e.g. first-contact chat). Returns 401 on missing/invalid token.
 */
export const requireAuthUser = createMiddleware<AuthUserEnv>(async (c, next) => {
  if (Deno.env.get("SKIP_AUTH") === "true") {
    const devUser: AuthUser = {
      id: "dev-customer",
      email: "customer@localhost",
      role: "customer",
    };
    c.set("authUser", devUser);
    await withContext({ userId: devUser.id }, next);
    return;
  }

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      401,
    );
  }

  const token = auth.slice(7);
  const user = await verifyToken(token);
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
      401,
    );
  }

  c.set("authUser", user);
  await withContext({ userId: user.id }, next);
});
