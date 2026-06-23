import { getLogger } from "@logtape/logtape";
import { sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";

const logger = getLogger(["hmls", "agent", "fixo-rate-limit"]);

export const RATE_LIMITS = { perMin: 20, perDay: 200 } as const;

/** Pure: fixed-window bucket keys for a given instant. */
export function bucketKeys(now: Date): { min: string; day: string } {
  const iso = now.toISOString();
  return { min: `min:${iso.slice(0, 16)}`, day: `day:${iso.slice(0, 10)}` };
}

async function bump(keyId: string, bucket: string): Promise<number> {
  // Atomic upsert-increment; returns the new count for this window.
  const [row] = await db.insert(schema.fixoRateLimit)
    .values({ keyId, bucket, count: 1 })
    .onConflictDoUpdate({
      target: [schema.fixoRateLimit.keyId, schema.fixoRateLimit.bucket],
      set: { count: sql`${schema.fixoRateLimit.count} + 1` },
    })
    .returning({ count: schema.fixoRateLimit.count });
  return row.count;
}

/** Increment both windows; over either limit → not ok. Date is runtime-only
 *  (gateway request handler, not a workflow script — `new Date()` is fine).
 *
 *  Fail-open on undefined-table (Postgres 42P01): migration 0033 creates
 *  fixo_rate_limit, but code ships before migrations run. During that brief
 *  deploy→migrate window, degrading to "no limit + warn" is far better than
 *  500-ing the entire live public API. The warning is logged so ops can see it;
 *  once 0033 lands the error stops and the table self-heals. All other DB
 *  errors are re-thrown unchanged so real failures are not masked. */
export async function checkRateLimit(
  keyId: string,
): Promise<{ ok: true } | { ok: false; scope: "min" | "day" }> {
  try {
    const { min, day } = bucketKeys(new Date());
    const minCount = await bump(keyId, min);
    if (minCount > RATE_LIMITS.perMin) return { ok: false, scope: "min" };
    const dayCount = await bump(keyId, day);
    if (dayCount > RATE_LIMITS.perDay) return { ok: false, scope: "day" };
    return { ok: true };
  } catch (e) {
    const isMissingTable = (e && typeof e === "object" && "code" in e &&
      (e as { code?: string }).code === "42P01") ||
      (e instanceof Error &&
        /relation .*fixo_rate_limit.* does not exist/i.test(e.message));
    if (isMissingTable) {
      logger
        .warn`checkRateLimit: fixo_rate_limit table missing (migration 0033 not yet applied) — failing open for key ${keyId}`;
      return { ok: true };
    }
    throw e;
  }
}
