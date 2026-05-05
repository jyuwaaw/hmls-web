// apps/gateway/src/middleware/fixo/tier.ts
import { db, schema } from "@hmls/agent/db";
import { and, count, eq, gte } from "drizzle-orm";
import type { AuthContext } from "./auth.ts";

const FREE_LIMITS = {
  userMessagesPerMonth: 5,
  reportsPerMonth: 1,
} as const;

function monthStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function monthDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function requireTextQuota(auth: AuthContext): Promise<Response | null> {
  if (auth.tier === "plus") return null;

  const month = monthDateString();
  const [{ value }] = await db
    .select({ value: count() })
    .from(schema.fixoMessageEvents)
    .where(
      and(
        eq(schema.fixoMessageEvents.userId, auth.userId),
        eq(schema.fixoMessageEvents.month, month),
      ),
    );

  if (Number(value) > FREE_LIMITS.userMessagesPerMonth) {
    return new Response(
      JSON.stringify({
        error: "limit_reached",
        message:
          `Free plan limit reached (${FREE_LIMITS.userMessagesPerMonth} messages/month). Upgrade to Plus for unlimited chat.`,
        usage: { used: Number(value), limit: FREE_LIMITS.userMessagesPerMonth },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

export async function requireReportQuota(auth: AuthContext): Promise<Response | null> {
  if (auth.tier === "plus") return null;

  const start = monthStart();
  const [{ value }] = await db
    .select({ value: count() })
    .from(schema.fixoReports)
    .where(
      and(
        eq(schema.fixoReports.userId, auth.userId),
        gte(schema.fixoReports.generatedAt, start),
      ),
    );

  if (Number(value) >= FREE_LIMITS.reportsPerMonth) {
    return new Response(
      JSON.stringify({
        error: "limit_reached",
        message:
          `Free plan limit reached (${FREE_LIMITS.reportsPerMonth} report/month). Upgrade to Plus for unlimited reports.`,
        usage: { used: Number(value), limit: FREE_LIMITS.reportsPerMonth },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

export function requireMediaTier(auth: AuthContext): Response | null {
  if (auth.tier === "plus") return null;
  return new Response(
    JSON.stringify({
      error: "upgrade_required",
      message: "Upgrade to Plus to use photo, audio, video, and OBD diagnostics",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}
