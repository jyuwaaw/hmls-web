import { verifyToken } from "../../lib/supabase.ts";
import { db, schema } from "@hmls/agent/db";
import { grantMonthly, MONTHLY_GRANT, type Tier } from "@hmls/agent";
import { eq } from "drizzle-orm";

export interface AuthContext {
  userId: string; // Supabase auth.users.id
  email: string;
  tier: Tier;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  // Legacy support for existing HMLS customers
  customerId?: number;
}

export async function authenticateRequest(
  request: Request,
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Missing authorization header" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const token = authHeader.slice(7);
  const authUser = await verifyToken(token);

  if (!authUser) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Try user_profiles first (SaaS users)
  const [profile] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.id, authUser.id))
    .limit(1);

  if (profile) {
    return {
      userId: profile.id,
      email: authUser.email,
      tier: profile.tier,
      stripeCustomerId: profile.stripeCustomerId,
      stripeSubscriptionId: profile.stripeSubscriptionId,
    };
  }

  // Fallback: legacy HMLS customer lookup
  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.email, authUser.email))
    .limit(1);

  if (customer) {
    return {
      userId: authUser.id,
      email: authUser.email,
      tier: "plus" as const, // legacy customers get full access
      stripeCustomerId: customer.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
      customerId: customer.id,
    };
  }

  // Auto-create user_profiles for new SaaS users + grant initial free
  // credits. grantMonthly writes both the balance and the ledger row, so
  // the new user shows up in /balance and the audit trail starts from
  // creation.
  const [newProfile] = await db
    .insert(schema.userProfiles)
    .values({ id: authUser.id })
    .returning();
  await grantMonthly({
    userId: newProfile.id,
    amount: MONTHLY_GRANT.free,
    reason: "free_monthly_grant",
    metadata: { source: "auto_provision_on_first_login" },
  });

  return {
    userId: newProfile.id,
    email: authUser.email,
    tier: "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  };
}
