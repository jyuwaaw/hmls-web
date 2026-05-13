// Local DB-backed credit accounting for Fixo.
//
// Replaces the previous Stripe-balance round-trip path. Hot reads/writes
// touch only user_profiles + credit_ledger. Stripe is referenced only when
// a paid event lands (subscription renewal, top-up purchase) via webhook.
//
// Two buckets per user:
//   - monthly: granted on subscription period (Plus = 2000, Pro = 6000) or
//     rolling 30-day window (Free = 100). Resets on each grant — unused
//     expires.
//   - topup: bought via one-time Stripe Checkout. Never expires.
// Consumption deducts monthly first, falls through to topup. The DB has
// CHECK constraints preventing either bucket from going negative.

import { and, desc, eq, gte, lt, sql, sum } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";

const { userProfiles, creditLedger, promoCodes, promoRedemptions } = schema;

// --- Pricing ---

/**
 * Credit cost per input action. Audio/video are charged per 30-second
 * block, rounded up (a 31s clip = 2 blocks).
 *
 * Calibration:
 *   - photo (30) is the baseline. Real Gemini 2.5 Flash cost ~ $0.0002/photo.
 *   - text/obd (10) is light: a single short-context turn.
 *   - audio (40 / 30s) reflects spectrogram preprocessing + acoustic
 *     reasoning overhead on top of raw token cost.
 *   - video (80 / 30s) reflects frame extraction + temporal reasoning
 *     (~3-4x photo per real cost).
 *   - report (100) is the priciest single action: long-context
 *     summarization + PDF generation.
 *
 * Free tier (100/mo) is a try-the-platform allowance — a few quick text
 * turns + 1-2 photos, not a full diagnostic. Plus tier (2000/mo) covers
 * ~8-10 full diagnostics. Heavy users top up.
 */
export const CREDIT_COSTS = {
  text: 10,
  obd: 10,
  photo: 30,
  audio: 40, // per 30s
  video: 80, // per 30s
  report: 100,
} as const;

export type InputKind = keyof typeof CREDIT_COSTS;

/**
 * Compute the credit cost for a given action. Audio/video round up to the
 * next 30-second block; everything else is flat.
 */
export function calculateCost(
  kind: InputKind,
  durationSeconds?: number,
): number {
  if (kind === "audio" || kind === "video") {
    const blocks = Math.max(1, Math.ceil((durationSeconds ?? 30) / 30));
    return blocks * CREDIT_COSTS[kind];
  }
  return CREDIT_COSTS[kind];
}

// --- Grant amounts ---

/**
 * Monthly grant per tier. Pro (6000) is a forward-compatible placeholder
 * — when Stripe Pro Product launches, this value may be tuned. No code
 * change required; webhook resolves tier via tierFromPriceId.
 */
export const MONTHLY_GRANT = {
  free: 100,
  plus: 2000,
  pro: 6000,
} as const;

export type Tier = keyof typeof MONTHLY_GRANT;

// --- Top-up rate ---

/**
 * Top-up rate: a flat $1 buys 100 credits, same per-credit price as the
 * Plus monthly grant ($19.90 / 2000cr ≈ $0.01/cr). No volume discount —
 * flat pricing is easier to communicate and keeps Plus's value prop as
 * "auto-renew + don't think about it" rather than a discount.
 *
 * Stored as cents-per-credit because it lines up with Stripe's
 * unit_amount (cents) and avoids floating-point math in the hot path.
 */
export const TOPUP_CENTS_PER_CREDIT = 1;

/** UI preset amounts (dollars). Modal renders these as quick buttons; a
 * custom input handles arbitrary amounts. Server caps the dollars range
 * for abuse prevention. */
export const SUGGESTED_TOPUPS_USD = [5, 20, 50] as const;

/** Min/max dollar amount accepted by the topup endpoint. Cap is purely a
 * safety guard against fat-finger / abuse — raise or remove if you want
 * to support enterprise top-ups. */
export const TOPUP_MIN_USD = 1;
export const TOPUP_MAX_USD = 200;

/** Convert a dollar amount to credits at the flat rate. Integer math. */
export function creditsForUsd(dollars: number): number {
  return Math.floor((dollars * 100) / TOPUP_CENTS_PER_CREDIT);
}

/** Free users get a fresh grant if their period_start is older than this. */
const FREE_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

// --- Read ---

export interface CreditBalance {
  monthly: number;
  topup: number;
  total: number;
}

/**
 * Read the user's current balance. Lazily refreshes the free-tier monthly
 * grant if the rolling 30-day window has elapsed (no-op for Plus/Pro).
 */
export async function getBalance(userId: string): Promise<CreditBalance> {
  await ensureFreshMonthlyGrant(userId);
  const [profile] = await db
    .select({
      monthly: userProfiles.creditsMonthlyRemaining,
      topup: userProfiles.creditsTopupRemaining,
    })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId))
    .limit(1);
  const m = profile?.monthly ?? 0;
  const t = profile?.topup ?? 0;
  return { monthly: m, topup: t, total: m + t };
}

// --- Consume ---

export class InsufficientCreditsError extends Error {
  override readonly name = "InsufficientCreditsError";
  constructor(
    public readonly balance: number,
    public readonly required: number,
  ) {
    super(`Insufficient credits: have ${balance}, need ${required}`);
  }
}

/**
 * Atomically deduct `cost` credits. Spends the monthly bucket first, then
 * falls through to topup. Records one ledger row per bucket touched.
 *
 * Throws InsufficientCreditsError if combined balance < cost. The DB
 * CHECK constraints are a defense-in-depth backstop.
 */
export async function consumeCredits(opts: {
  userId: string;
  cost: number;
  sessionId?: number | null;
  inputType?: InputKind | null;
  metadata?: Record<string, unknown>;
}): Promise<{
  fromMonthly: number;
  fromTopup: number;
  balanceAfter: CreditBalance;
}> {
  return await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({
        monthly: userProfiles.creditsMonthlyRemaining,
        topup: userProfiles.creditsTopupRemaining,
      })
      .from(userProfiles)
      .where(eq(userProfiles.id, opts.userId))
      .for("update")
      .limit(1);

    if (!profile) {
      throw new Error(
        `consumeCredits: user_profile ${opts.userId} not found`,
      );
    }

    const total = profile.monthly + profile.topup;
    if (total < opts.cost) {
      throw new InsufficientCreditsError(total, opts.cost);
    }

    const fromMonthly = Math.min(profile.monthly, opts.cost);
    const fromTopup = opts.cost - fromMonthly;

    await tx
      .update(userProfiles)
      .set({
        creditsMonthlyRemaining: profile.monthly - fromMonthly,
        creditsTopupRemaining: profile.topup - fromTopup,
      })
      .where(eq(userProfiles.id, opts.userId));

    const rows: typeof creditLedger.$inferInsert[] = [];
    if (fromMonthly > 0) {
      rows.push({
        userId: opts.userId,
        delta: -fromMonthly,
        bucket: "monthly",
        reason: "consumption",
        sessionId: opts.sessionId ?? null,
        inputType: opts.inputType ?? null,
        metadata: opts.metadata ?? null,
      });
    }
    if (fromTopup > 0) {
      rows.push({
        userId: opts.userId,
        delta: -fromTopup,
        bucket: "topup",
        reason: "consumption",
        sessionId: opts.sessionId ?? null,
        inputType: opts.inputType ?? null,
        metadata: opts.metadata ?? null,
      });
    }
    if (rows.length > 0) {
      await tx.insert(creditLedger).values(rows);
    }

    return {
      fromMonthly,
      fromTopup,
      balanceAfter: {
        monthly: profile.monthly - fromMonthly,
        topup: profile.topup - fromTopup,
        total: total - opts.cost,
      },
    };
  });
}

// --- Grants ---

/**
 * Grant the monthly bucket. RESETS unused credits — this is the expiry
 * mechanism. Used by both subscription renewals (via Stripe webhook) and
 * Free monthly refreshes (lazy on read or future cron).
 *
 * Idempotency:
 *   - subscription_grant: keyed on `stripeEvent` via the credit_ledger
 *     UNIQUE index. Stripe retries the same event.id — UNIQUE blocks dupes.
 *   - free_monthly_grant: no Stripe event, so we lock the user_profiles
 *     row and re-check `monthlyGrantPeriodStart` inside the tx. Two
 *     concurrent lazy refreshes can both pass the outer 30-day check; the
 *     inner re-check ensures only one wins. Without this, a spend landing
 *     between the two grants gets refunded by the second's overwrite.
 */
export async function grantMonthly(opts: {
  userId: string;
  amount: number;
  reason: "subscription_grant" | "free_monthly_grant";
  stripeEvent?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ granted: boolean }> {
  return await db.transaction(async (tx) => {
    if (opts.stripeEvent) {
      const [existing] = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.stripeEvent, opts.stripeEvent))
        .limit(1);
      if (existing) return { granted: false };
    }

    // Lock the row and re-check period for free grants. Plus/Pro grants
    // are protected by the stripeEvent UNIQUE index so the re-check is
    // a no-op for them, but locking is cheap and serializes against
    // concurrent consumeCredits.
    const [current] = await tx
      .select({ periodStart: userProfiles.monthlyGrantPeriodStart })
      .from(userProfiles)
      .where(eq(userProfiles.id, opts.userId))
      .for("update")
      .limit(1);

    if (!current) {
      // user_profiles row vanished between caller and tx start (deleted
      // user). Skip silently.
      return { granted: false };
    }

    if (opts.reason === "free_monthly_grant") {
      const since = current.periodStart?.getTime() ?? 0;
      if (Date.now() - since < FREE_REFRESH_INTERVAL_MS) {
        // Another concurrent caller already granted this period. Skip.
        return { granted: false };
      }
    }

    await tx
      .update(userProfiles)
      .set({
        creditsMonthlyRemaining: opts.amount,
        monthlyGrantPeriodStart: new Date(),
      })
      .where(eq(userProfiles.id, opts.userId));
    await tx.insert(creditLedger).values({
      userId: opts.userId,
      delta: opts.amount,
      bucket: "monthly",
      reason: opts.reason,
      stripeEvent: opts.stripeEvent ?? null,
      metadata: opts.metadata ?? null,
    });
    return { granted: true };
  });
}

/**
 * Add to the top-up bucket. Idempotent on stripeEvent. Top-up credits are
 * additive (do not reset existing balance) and never expire.
 */
export async function grantTopup(opts: {
  userId: string;
  amount: number;
  stripeEvent: string;
  metadata?: Record<string, unknown>;
}): Promise<{ granted: boolean }> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.stripeEvent, opts.stripeEvent))
      .limit(1);
    if (existing) return { granted: false };
    await tx
      .update(userProfiles)
      .set({
        creditsTopupRemaining: sql`${userProfiles.creditsTopupRemaining} + ${opts.amount}`,
      })
      .where(eq(userProfiles.id, opts.userId));
    await tx.insert(creditLedger).values({
      userId: opts.userId,
      delta: opts.amount,
      bucket: "topup",
      reason: "topup_purchase",
      stripeEvent: opts.stripeEvent,
      metadata: opts.metadata ?? null,
    });
    return { granted: true };
  });
}

// --- Promo codes (bonus credits, non-monetary) ---

export class PromoRedemptionError extends Error {
  override readonly name = "PromoRedemptionError";
  constructor(
    public readonly code:
      | "not_found"
      | "expired"
      | "exhausted"
      | "already_redeemed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Redeem a promo code for the user. Atomic: if anyone of the checks
 * fails, no credits are granted and no row is written.
 *
 * Idempotency on (code, user_id) via the UNIQUE constraint — if the same
 * user submits the same code twice, second redemption errors with
 * `already_redeemed`. The grantTopup call also uses
 * `stripeEvent="promo:CODE:userId"` so credit_ledger guards against any
 * accidental double-write.
 */
export async function redeemPromoCode(opts: {
  userId: string;
  code: string;
}): Promise<{ credits: number; balanceAfter: CreditBalance }> {
  const code = opts.code.trim().toUpperCase();
  if (!code) {
    throw new PromoRedemptionError("not_found", "Code is required");
  }

  return await db.transaction(async (tx) => {
    // Lock the promo_code row so concurrent redemptions don't race past
    // max_uses.
    const [promo] = await tx
      .select({
        code: promoCodes.code,
        credits: promoCodes.credits,
        maxUses: promoCodes.maxUses,
        uses: promoCodes.uses,
        expiresAt: promoCodes.expiresAt,
      })
      .from(promoCodes)
      .where(eq(promoCodes.code, code))
      .for("update")
      .limit(1);

    if (!promo) {
      throw new PromoRedemptionError("not_found", "Code not found");
    }
    if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
      throw new PromoRedemptionError("expired", "Code has expired");
    }
    if (promo.uses >= promo.maxUses) {
      throw new PromoRedemptionError(
        "exhausted",
        "Code has been fully redeemed",
      );
    }

    // Per-user guard: same user can't redeem same code twice.
    const [existing] = await tx
      .select({ id: promoRedemptions.id })
      .from(promoRedemptions)
      .where(
        and(
          eq(promoRedemptions.code, code),
          eq(promoRedemptions.userId, opts.userId),
        ),
      )
      .limit(1);
    if (existing) {
      throw new PromoRedemptionError(
        "already_redeemed",
        "You've already redeemed this code",
      );
    }

    // Bump promo_codes.uses + insert ledger row + insert redemption.
    // Inline rather than calling grantTopup so we can chain the ledger
    // INSERT into the same tx and capture the ledger_id.
    const stripeEvent = `promo:${code}:${opts.userId}`;
    await tx
      .update(userProfiles)
      .set({
        creditsTopupRemaining: sql`${userProfiles.creditsTopupRemaining} + ${promo.credits}`,
      })
      .where(eq(userProfiles.id, opts.userId));

    const [ledgerRow] = await tx
      .insert(creditLedger)
      .values({
        userId: opts.userId,
        delta: promo.credits,
        bucket: "topup",
        reason: "topup_purchase",
        stripeEvent,
        metadata: { promoCode: code },
      })
      .returning({ id: creditLedger.id });

    await tx
      .update(promoCodes)
      .set({ uses: promo.uses + 1 })
      .where(eq(promoCodes.code, code));

    await tx.insert(promoRedemptions).values({
      code,
      userId: opts.userId,
      ledgerId: ledgerRow.id,
    });

    // Re-read balance for the caller's UI.
    const [profile] = await tx
      .select({
        monthly: userProfiles.creditsMonthlyRemaining,
        topup: userProfiles.creditsTopupRemaining,
      })
      .from(userProfiles)
      .where(eq(userProfiles.id, opts.userId))
      .limit(1);

    return {
      credits: promo.credits,
      balanceAfter: {
        monthly: profile?.monthly ?? 0,
        topup: profile?.topup ?? 0,
        total: (profile?.monthly ?? 0) + (profile?.topup ?? 0),
      },
    };
  });
}

/**
 * Revoke credits granted by a top-up that's been refunded externally
 * (Stripe Dashboard refund or `charge.refunded` webhook). Subtracts from
 * the topup bucket, capped at 0 — if the user already spent some of the
 * topup, we eat the loss rather than letting the balance go negative.
 *
 * Writes a NEGATIVE-delta ledger row with reason='refund'. Idempotent on
 * `stripeEvent`. Returns `{revoked: false}` if the ledger row already
 * exists.
 */
export async function revokeTopupCredits(opts: {
  userId: string;
  amount: number;
  sessionId?: number | null;
  stripeEvent?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ revoked: boolean; deducted: number }> {
  if (opts.amount <= 0) return { revoked: false, deducted: 0 };
  return await db.transaction(async (tx) => {
    if (opts.stripeEvent) {
      const [existing] = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.stripeEvent, opts.stripeEvent))
        .limit(1);
      if (existing) return { revoked: false, deducted: 0 };
    }
    // Lock + read current topup so we know how much we can actually
    // deduct (cap at current balance — user may have spent some).
    const [profile] = await tx
      .select({ topup: userProfiles.creditsTopupRemaining })
      .from(userProfiles)
      .where(eq(userProfiles.id, opts.userId))
      .for("update")
      .limit(1);
    if (!profile) return { revoked: false, deducted: 0 };
    const deducted = Math.min(profile.topup, opts.amount);
    if (deducted === 0) {
      // User already at 0 — nothing to revoke. Still record the event
      // for audit so we don't try again.
      await tx.insert(creditLedger).values({
        userId: opts.userId,
        delta: 0,
        bucket: "topup",
        reason: "refund",
        sessionId: opts.sessionId ?? null,
        stripeEvent: opts.stripeEvent ?? null,
        metadata: {
          ...opts.metadata,
          requested_revoke: opts.amount,
          actual_deducted: 0,
          note: "user balance already 0 — refund recorded but no deduction",
        },
      });
      return { revoked: true, deducted: 0 };
    }
    await tx
      .update(userProfiles)
      .set({
        creditsTopupRemaining: sql`${userProfiles.creditsTopupRemaining} - ${deducted}`,
      })
      .where(eq(userProfiles.id, opts.userId));
    await tx.insert(creditLedger).values({
      userId: opts.userId,
      delta: -deducted,
      bucket: "topup",
      reason: "refund",
      sessionId: opts.sessionId ?? null,
      stripeEvent: opts.stripeEvent ?? null,
      metadata: {
        ...opts.metadata,
        requested_revoke: opts.amount,
        actual_deducted: deducted,
      },
    });
    return { revoked: true, deducted };
  });
}

/**
 * Refund credits previously consumed (e.g. when an LLM call charged but
 * then failed). Adds the refund to the topup bucket so it doesn't expire
 * with the next monthly grant — the user paid for it (or earned it via
 * Free grant) and a failure on our side shouldn't cost them.
 *
 * Writes a positive-delta ledger row with reason='refund'. When
 * `stripeEvent` is provided, idempotent against that event.id via the
 * credit_ledger UNIQUE index — webhook retries are safe.
 *
 * Returns `{ refunded: false }` when a row with the same stripeEvent
 * already exists (no-op).
 */
export async function refundCredits(opts: {
  userId: string;
  amount: number;
  sessionId?: number | null;
  reason?: string;
  stripeEvent?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ refunded: boolean }> {
  if (opts.amount <= 0) return { refunded: false };
  return await db.transaction(async (tx) => {
    if (opts.stripeEvent) {
      const [existing] = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.stripeEvent, opts.stripeEvent))
        .limit(1);
      if (existing) return { refunded: false };
    }
    await tx
      .update(userProfiles)
      .set({
        creditsTopupRemaining: sql`${userProfiles.creditsTopupRemaining} + ${opts.amount}`,
      })
      .where(eq(userProfiles.id, opts.userId));
    await tx.insert(creditLedger).values({
      userId: opts.userId,
      delta: opts.amount,
      bucket: "topup",
      reason: "refund",
      sessionId: opts.sessionId ?? null,
      stripeEvent: opts.stripeEvent ?? null,
      metadata: { ...opts.metadata, originalReason: opts.reason ?? null },
    });
    return { refunded: true };
  });
}

// --- Usage audit (read-only views over credit_ledger) ---

export interface UsageStats {
  /** Sum of |delta| for consumption rows in window. */
  totalSpent: number;
  /** Most recent monthly grant amount (the user's "this period quota"). */
  grantedThisPeriod: number;
  /** When the current monthly window started. Null if user has never been
   * granted (impossible after auto-provision). */
  monthlyPeriodStart: Date | null;
  /** Predicted next refresh date for free tier (period_start + 30d). Null
   * for Plus/Pro (Stripe-driven, unpredictable in code). */
  nextFreeRefreshAt: Date | null;
  /** Spend grouped by input_type. */
  byInputType: Record<string, number>;
  /** ISO bounds of the window summarized. */
  period: { from: string; to: string };
}

/**
 * Read recent ledger entries for a user. Default 50 rows, newest first.
 * Pagination via `before` (created_at cursor) returning hasMore so the
 * client can render an infinite-scroll-style history.
 */
export async function getCreditHistory(opts: {
  userId: string;
  limit?: number;
  before?: Date;
}): Promise<{
  entries: typeof creditLedger.$inferSelect[];
  hasMore: boolean;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = [eq(creditLedger.userId, opts.userId)];
  if (opts.before) {
    conditions.push(lt(creditLedger.createdAt, opts.before));
  }
  // Fetch one extra row to detect hasMore without a separate COUNT.
  const rows = await db
    .select()
    .from(creditLedger)
    .where(and(...conditions))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { entries: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Aggregate usage for a user over a window (default: since their current
 * monthly period started). Returns spend total, group-by-input-type
 * breakdown, and the predicted next-refresh date for Free users.
 */
export async function getUsageStats(opts: {
  userId: string;
  since?: Date;
}): Promise<UsageStats> {
  // Pull the user's tier + period_start to anchor the default window and
  // compute next-refresh. Single query.
  const [profile] = await db
    .select({
      tier: userProfiles.tier,
      periodStart: userProfiles.monthlyGrantPeriodStart,
    })
    .from(userProfiles)
    .where(eq(userProfiles.id, opts.userId))
    .limit(1);

  const monthlyPeriodStart = profile?.periodStart ?? null;
  const since = opts.since ?? monthlyPeriodStart ?? new Date(0);
  const now = new Date();

  // Total spent in window: sum of -delta on consumption rows (delta is
  // negative for consumption so we negate to get a positive "spent"
  // number). We use sum() and coerce to number client-side because
  // Drizzle returns decimal as string.
  const consumptionConditions = [
    eq(creditLedger.userId, opts.userId),
    eq(creditLedger.reason, "consumption"),
    gte(creditLedger.createdAt, since),
  ];

  const [totalRow] = await db
    .select({
      total: sum(sql<number>`-${creditLedger.delta}`),
    })
    .from(creditLedger)
    .where(and(...consumptionConditions));

  const byTypeRows = await db
    .select({
      inputType: creditLedger.inputType,
      total: sum(sql<number>`-${creditLedger.delta}`),
    })
    .from(creditLedger)
    .where(and(...consumptionConditions))
    .groupBy(creditLedger.inputType);

  const byInputType: Record<string, number> = {};
  for (const row of byTypeRows) {
    if (row.inputType) byInputType[row.inputType] = Number(row.total ?? 0);
  }

  // Most recent grant (any monthly grant — covers subscription_grant,
  // free_monthly_grant, legacy_migration).
  const [latestGrant] = await db
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, opts.userId),
        eq(creditLedger.bucket, "monthly"),
      ),
    )
    .orderBy(desc(creditLedger.createdAt))
    .limit(1);

  // Next refresh: only meaningful for Free users (Plus/Pro is Stripe-driven).
  let nextFreeRefreshAt: Date | null = null;
  if (profile?.tier === "free" && monthlyPeriodStart) {
    nextFreeRefreshAt = new Date(
      monthlyPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
  }

  return {
    totalSpent: Number(totalRow?.total ?? 0),
    grantedThisPeriod: latestGrant?.delta ?? 0,
    monthlyPeriodStart,
    nextFreeRefreshAt,
    byInputType,
    period: {
      from: since.toISOString(),
      to: now.toISOString(),
    },
  };
}

/**
 * If the user is on the free tier and their monthly grant is older than
 * the refresh window, top up to MONTHLY_GRANT.free. No-op for Plus/Pro
 * users (they're refreshed by Stripe `invoice.payment_succeeded` webhook).
 *
 * Called from getBalance() and from the credits middleware before any
 * consumption check, so a free user who hasn't logged in for a month gets
 * their grant on next request.
 */
export async function ensureFreshMonthlyGrant(userId: string): Promise<void> {
  const [profile] = await db
    .select({
      tier: userProfiles.tier,
      periodStart: userProfiles.monthlyGrantPeriodStart,
    })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId))
    .limit(1);
  if (!profile || profile.tier !== "free") return;
  const since = profile.periodStart?.getTime() ?? 0;
  if (Date.now() - since < FREE_REFRESH_INTERVAL_MS) return;
  await grantMonthly({
    userId,
    amount: MONTHLY_GRANT.free,
    reason: "free_monthly_grant",
  });
}
