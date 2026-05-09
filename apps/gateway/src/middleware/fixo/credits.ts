// Unified credit gating + charging middleware.
//
// Replaces the old split between Stripe-balance credits (legacy customers)
// and tier-based quotas (free vs plus). Now: every SaaS user pays credits
// from their local balance. Legacy HMLS `customers` (auth.customerId set)
// still bypass the credit system entirely — they're a grandfathered set.
//
// Use checkCreditsForInput / chargeForInput for media/OBD/text uploads.
// Use chargeForReport when the agent kicks off PDF report generation.

import {
  calculateCost,
  consumeCredits,
  CREDIT_COSTS,
  type CreditBalance,
  ensureFreshMonthlyGrant,
  getBalance,
  type InputKind,
  InsufficientCreditsError,
} from "@hmls/agent";
import type { AuthContext } from "./auth.ts";

export interface CreditCheck {
  ok: boolean;
  balance: CreditBalance;
  required: number;
}

/** True if credits should be checked/charged for this caller. */
function isCreditedUser(auth: AuthContext): boolean {
  // DEV_MODE in fixo-app.ts injects a synthetic auth context whose userId
  // does NOT correspond to a real user_profiles row. Routing it through
  // consumeCredits would crash with "user_profile not found". Bypass.
  // (F4 fix from prior review.)
  if (Deno.env.get("DEV_MODE") === "true") return false;
  // Legacy HMLS customers (auth.customerId set) bypass credits — they're
  // a grandfathered free pass. Everyone else (SaaS users) is on credits.
  return !auth.customerId;
}

/**
 * Pre-check: does the user have enough credits for this action? Use this
 * for early-rejection before doing expensive work (uploads, LLM calls).
 * Returns ok=true for legacy customers and DEV_MODE (they bypass credits).
 */
export async function checkCreditsForInput(
  auth: AuthContext,
  kind: InputKind,
  durationSeconds?: number,
): Promise<CreditCheck> {
  const required = calculateCost(kind, durationSeconds);
  if (!isCreditedUser(auth)) {
    return {
      ok: true,
      balance: { monthly: 0, topup: 0, total: Number.POSITIVE_INFINITY },
      required,
    };
  }
  await ensureFreshMonthlyGrant(auth.userId);
  const balance = await getBalance(auth.userId);
  return { ok: balance.total >= required, balance, required };
}

/**
 * Atomically charge for an input action. Returns charge info on success,
 * or a 402 Response on insufficient credits (uniform error shape so
 * callers' error handling doesn't change).
 *
 * Triggers the Free monthly lazy refresh BEFORE checking the balance.
 * This is the hot path — without this, a Free user whose 30-day window
 * has elapsed only gets their refresh when they happen to hit
 * /billing/balance first, leaving them stuck at zero on chat / media.
 */
export async function chargeForInput(opts: {
  auth: AuthContext;
  kind: InputKind;
  sessionId?: number;
  durationSeconds?: number;
}): Promise<{ charged: number; balanceAfter: CreditBalance } | Response> {
  if (!isCreditedUser(opts.auth)) {
    return {
      charged: 0,
      balanceAfter: { monthly: 0, topup: 0, total: Number.POSITIVE_INFINITY },
    };
  }
  await ensureFreshMonthlyGrant(opts.auth.userId);
  const required = calculateCost(opts.kind, opts.durationSeconds);
  try {
    const result = await consumeCredits({
      userId: opts.auth.userId,
      cost: required,
      sessionId: opts.sessionId,
      inputType: opts.kind,
    });
    return { charged: required, balanceAfter: result.balanceAfter };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return insufficientCreditsResponse(err.balance, err.required);
    }
    throw err;
  }
}

/** Charge for a generated PDF report. Same shape as chargeForInput. */
export function chargeForReport(opts: {
  auth: AuthContext;
  sessionId?: number;
}): Promise<{ charged: number; balanceAfter: CreditBalance } | Response> {
  return chargeForInput({
    auth: opts.auth,
    kind: "report",
    sessionId: opts.sessionId,
  });
}

function insufficientCreditsResponse(
  balance: number,
  required: number,
): Response {
  return new Response(
    JSON.stringify({
      error: "insufficient_credits",
      message: `Not enough credits: have ${balance}, need ${required}. Upgrade to Plus or top up.`,
      balance,
      required,
      shortfall: required - balance,
    }),
    {
      status: 402,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Re-export pricing so call sites can show "this will cost N credits" UI.
export { CREDIT_COSTS };
