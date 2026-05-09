// Stripe API helpers for Fixo: subscription checkout, top-up checkout,
// customer portal, and webhook routing.
//
// Credit balances are NOT stored on Stripe customer.balance anymore —
// see ./credits.ts for the local DB-backed accounting. Stripe is only
// the system of record for "money has changed hands"; we mirror those
// events into our ledger.
//
// API version is pinned to defend against silent SDK behavior changes.
// The pinned version must match what our installed Stripe SDK supports —
// see deno.json `stripe` dep. Webhook endpoint API version in Stripe
// Dashboard must match this pin — otherwise event payload shapes diverge
// from what this code parses.
//
// Stripe's true-latest (per their best-practices skill) is
// `2026-04-22.dahlia`, but our SDK (v20.4.1) only types up to
// `2026-02-25.clover`. SDK upgrade is tracked as a follow-up.

import Stripe from "stripe";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import {
  creditsForUsd,
  grantMonthly,
  grantTopup,
  MONTHLY_GRANT,
  revokeTopupCredits,
  type Tier,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
} from "./credits.ts";

const { userProfiles, creditLedger } = schema;

// --- Stripe client (lazy singleton) ---

const STRIPE_API_VERSION = "2026-02-25.clover" as const;

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is required");
    }
    _stripe = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return _stripe;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getStripe();
    const value = client[prop as keyof typeof client];
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});

// --- Tier resolution via Stripe Price lookup_key ---

/**
 * Map of internal tier name → Stripe Price `lookup_key`. The lookup_key is
 * a stable, human-readable handle Stripe lets you set on a Price object
 * (Dashboard or API). Using lookup_keys instead of raw Price IDs means:
 *
 *  - Pricing changes don't require a deploy. Old Price archived → new
 *    Price gets the same lookup_key (Stripe enforces uniqueness via
 *    `transfer_lookup_key: true`). Code resolves the new Price
 *    automatically.
 *  - Same code works in test + live (separate Stripe accounts can each
 *    have a Price with the same lookup_key).
 *  - One less env var to forget setting.
 *
 * Adding Pro is a Stripe Dashboard change only: create the Product,
 * create a recurring Price, set its lookup_key to `fixo_pro_monthly`.
 * No code change, no env var, no deploy.
 */
const TIER_LOOKUP_KEYS = {
  plus: "fixo_plus_monthly",
  pro: "fixo_pro_monthly",
} as const;

// Two-way cache. Hit on every webhook + every checkout, miss only on
// process startup / when Stripe rotates a Price under a lookup_key.
const tierToPriceCache = new Map<Tier, string>();
const priceToTierCache = new Map<string, Tier>();

/**
 * Look up the active Stripe Price ID for a given tier via its lookup_key.
 * Throws if the lookup_key has no active Price (i.e. you forgot to set
 * one up in Stripe — fail-fast at checkout creation rather than 30 days
 * later when nobody can renew).
 */
export async function getPriceIdForTier(
  tier: "plus" | "pro",
): Promise<string> {
  const cached = tierToPriceCache.get(tier);
  if (cached) return cached;
  const lookupKey = TIER_LOOKUP_KEYS[tier];
  const { data } = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const priceId = data[0]?.id;
  if (!priceId) {
    throw new Error(
      `No active Stripe Price found for lookup_key="${lookupKey}". ` +
        `Create the Price in Stripe Dashboard with this lookup_key.`,
    );
  }
  tierToPriceCache.set(tier, priceId);
  priceToTierCache.set(priceId, tier);
  return priceId;
}

/**
 * Resolve a Stripe Price ID to our internal tier by reading its
 * lookup_key. Returns null for unknown price IDs (e.g. legacy / archived
 * prices) — caller treats as "no tier change".
 *
 * Caches both directions so subsequent calls in the same process avoid
 * round-trips.
 */
export async function tierFromPriceId(priceId: string): Promise<Tier | null> {
  const cached = priceToTierCache.get(priceId);
  if (cached) return cached;
  let lookupKey: string | null = null;
  try {
    const price = await stripe.prices.retrieve(priceId);
    lookupKey = price.lookup_key ?? null;
  } catch (err) {
    // Price was deleted / inaccessible. Treat as unknown.
    console.warn("[stripe] tierFromPriceId: failed to retrieve price", {
      priceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!lookupKey) return null;
  const matchedTier = (Object.entries(TIER_LOOKUP_KEYS) as [Tier, string][])
    .find(([, k]) => k === lookupKey)?.[0];
  if (!matchedTier || matchedTier === "free") return null;
  priceToTierCache.set(priceId, matchedTier);
  tierToPriceCache.set(matchedTier, priceId);
  return matchedTier;
}

// --- Customer lookup / provisioning ---

export async function getStripeCustomerIdForUser(
  userId: string,
): Promise<string | null> {
  const [profile] = await db
    .select({ stripeCustomerId: userProfiles.stripeCustomerId })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId))
    .limit(1);
  return profile?.stripeCustomerId ?? null;
}

async function ensureStripeCustomer(
  userId: string,
  email: string,
): Promise<string> {
  const existing = await getStripeCustomerIdForUser(userId);
  if (existing) return existing;
  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  await db
    .update(userProfiles)
    .set({ stripeCustomerId: customer.id })
    .where(eq(userProfiles.id, userId));
  return customer.id;
}

// --- Checkout sessions ---

/**
 * Plus subscription checkout. Recurring monthly billing.
 *
 * Notes:
 * - We do NOT pass `payment_method_types` so Stripe enables dynamic
 *   payment methods (Stripe best practice — Dashboard configuration drives
 *   which methods show, optimizes for conversion).
 * - `allow_promotion_codes: true` surfaces the "Add promo code" field on
 *   Stripe Checkout. Coupons are managed in Stripe Dashboard.
 */
export async function createCheckoutSession(
  userId: string,
  email: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripeCustomerId = await ensureStripeCustomer(userId, email);
  // Resolves the active Plus Price via lookup_key — see TIER_LOOKUP_KEYS.
  // No env var needed; pricing changes flow through Stripe Dashboard.
  const priceId = await getPriceIdForTier("plus");
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    // We rely on the Stripe `invoice.payment_succeeded` webhook to grant
    // monthly credits on each renewal — same code path for first signup
    // and ongoing renewals.
  });
  return session.url!;
}

/**
 * Top-up checkout. One-time payment at the flat $1 = 100cr rate. The
 * checkout uses an inline `price_data` rather than a managed Stripe Price
 * ID, so the dollar amount can be arbitrary without having to pre-create
 * SKUs in the dashboard.
 *
 * userId + credits are encoded into checkout metadata so the webhook
 * (`checkout.session.completed` or `async_payment_succeeded`) can credit
 * the right user without round-tripping through stripe_customer_id.
 */
export async function createTopupCheckoutSession(opts: {
  userId: string;
  email: string;
  dollars: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  if (
    !Number.isFinite(opts.dollars) ||
    !Number.isInteger(opts.dollars) ||
    opts.dollars < TOPUP_MIN_USD ||
    opts.dollars > TOPUP_MAX_USD
  ) {
    throw new Error(
      `topup dollars must be an integer between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}`,
    );
  }
  const credits = creditsForUsd(opts.dollars);
  const stripeCustomerId = await ensureStripeCustomer(opts.userId, opts.email);
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Fixo credits — ${credits.toLocaleString()}`,
            description: `${credits.toLocaleString()} Fixo credits at $1 per 100 credits`,
          },
          unit_amount: opts.dollars * 100,
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: true,
    metadata: {
      kind: "topup",
      userId: opts.userId,
      credits: String(credits),
      dollars: String(opts.dollars),
    },
    // Mirror metadata onto the PaymentIntent so it survives in dashboard
    // search / refund tooling without traversing back to the session.
    payment_intent_data: {
      metadata: {
        kind: "topup",
        userId: opts.userId,
        credits: String(credits),
        dollars: String(opts.dollars),
      },
    },
  });
  return session.url!;
}

export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

// --- Webhook handler ---

/**
 * Type-narrow `invoice.subscription` (Stripe SDK types changed in recent
 * versions; can be string OR expanded Subscription object OR null).
 */
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  // deno-lint-ignore no-explicit-any
  const sub = (invoice as any).subscription as
    | string
    | { id: string }
    | null
    | undefined;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/**
 * Resolve the tier for a subscription by reading its first line item's
 * price ID. Subscriptions can technically have multiple items but Fixo
 * subscriptions always have one (Plus or Pro).
 *
 * Async because tierFromPriceId calls Stripe to read the Price's
 * lookup_key. Result is cached per process so repeated subscription
 * events for the same Price are O(1).
 */
async function tierFromSubscription(
  sub: Stripe.Subscription,
): Promise<Tier | null> {
  const priceId = sub.items.data[0]?.price?.id;
  if (!priceId) return null;
  return await tierFromPriceId(priceId);
}

/**
 * Build a guarded WHERE clause that drops stale subscription events.
 *
 * Stripe doesn't guarantee event delivery order. If a `subscription.deleted`
 * arrives AFTER a fresh `subscription.created` (rare but real), we'd flip
 * the user back to free. The `last_subscription_event_at` column lets us
 * compare timestamps and skip stale events — only update if the incoming
 * event is newer than the last applied one (or if no last is set yet).
 */
function notStaleSubscriptionEvent(eventCreatedAt: Date) {
  return or(
    sql`${userProfiles.lastSubscriptionEventAt} IS NULL`,
    lt(userProfiles.lastSubscriptionEventAt, eventCreatedAt),
  );
}

/**
 * Routes Stripe webhook events to the right local handler. Every credit-
 * mutating handler is idempotent on `event.id` via the credit_ledger
 * stripe_event UNIQUE index — Stripe retries are safe.
 *
 * Events handled:
 *   - customer.subscription.created/updated: tier flip via tierFromPriceId
 *     + out-of-order guard via last_subscription_event_at
 *   - customer.subscription.deleted: tier=free (same guard)
 *   - invoice.payment_succeeded: grant monthly credits matching the user's
 *     current tier (Plus = 2000, Pro = 6000). Idempotent on event.id.
 *   - invoice.payment_failed: log only (Stripe auto-retries via dunning;
 *     persistent failure → subscription.deleted eventually fires)
 *   - checkout.session.completed (mode=payment + metadata.kind=topup):
 *     grant top-up credits. Skip if payment_status === 'unpaid' (async
 *     payment methods like ACH/SEPA — wait for async_payment_succeeded).
 *   - checkout.session.async_payment_succeeded: same handler (after async
 *     payment lands). Idempotent on event.id.
 *   - checkout.session.async_payment_failed: log only (no grant happened).
 */
export async function handleSubscriptionWebhook(
  event: Stripe.Event,
): Promise<void> {
  const eventCreatedAt = new Date(event.created * 1000);

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const active = sub.status === "active" || sub.status === "trialing";
      const resolvedTier = await tierFromSubscription(sub);
      const newTier: Tier = active && resolvedTier ? resolvedTier : "free";
      await db
        .update(userProfiles)
        .set({
          stripeSubscriptionId: sub.id,
          tier: newTier,
          lastSubscriptionEventAt: eventCreatedAt,
        })
        .where(
          and(
            eq(userProfiles.stripeCustomerId, sub.customer as string),
            notStaleSubscriptionEvent(eventCreatedAt),
          ),
        );
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await db
        .update(userProfiles)
        .set({
          stripeSubscriptionId: null,
          tier: "free",
          lastSubscriptionEventAt: eventCreatedAt,
        })
        .where(
          and(
            eq(userProfiles.stripeCustomerId, sub.customer as string),
            notStaleSubscriptionEvent(eventCreatedAt),
          ),
        );
      // Leave any remaining monthly credits in place — the user paid for
      // that period; they should keep what they had until the next free
      // monthly refresh window resets them.
      break;
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = subscriptionIdFromInvoice(invoice);
      // Only act on subscription invoices — one-time top-up payments
      // come through checkout.session.completed instead.
      if (!subscriptionId) break;
      const customerId = invoice.customer as string;
      const [profile] = await db
        .select({ id: userProfiles.id, tier: userProfiles.tier })
        .from(userProfiles)
        .where(eq(userProfiles.stripeCustomerId, customerId))
        .limit(1);
      if (!profile) {
        console.warn(
          `[stripe-webhook] invoice.payment_succeeded for unknown customer ${customerId}`,
        );
        break;
      }
      // Skip free users — they shouldn't be receiving subscription invoices.
      // If we see one, it's a logical bug worth knowing about.
      if (profile.tier === "free") {
        console.warn(
          `[stripe-webhook] invoice.payment_succeeded for free-tier user ${profile.id}`,
        );
        break;
      }
      await grantMonthly({
        userId: profile.id,
        amount: MONTHLY_GRANT[profile.tier],
        reason: "subscription_grant",
        stripeEvent: event.id,
        metadata: {
          subscription_id: subscriptionId,
          invoice_id: invoice.id,
          tier: profile.tier,
          period_end: invoice.period_end,
        },
      });
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = subscriptionIdFromInvoice(invoice);
      console.warn("[stripe-webhook] invoice.payment_failed", {
        eventId: event.id,
        customerId: invoice.customer,
        subscriptionId,
        attempt: invoice.attempt_count,
      });
      // No credit mutation — Stripe retries automatically via dunning. If
      // all retries fail, customer.subscription.deleted will eventually
      // fire and our handler above will flip tier=free.
      //
      // Notify the user via email so they can update their card before
      // dunning gives up. Lazy import notifications to avoid pulling
      // mailer setup into webhook hot path when not used.
      const email = invoice.customer_email;
      if (email) {
        try {
          const { notifyPaymentFailed } = await import(
            "../../lib/notifications.ts"
          );
          const nextRetry = invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000)
            : null;
          await notifyPaymentFailed({
            toEmail: email,
            attempt: invoice.attempt_count ?? 1,
            nextRetryAt: nextRetry,
            manageBillingUrl: "https://fixo.hmls.autos/settings",
          });
        } catch (err) {
          console.error("[stripe-webhook] payment_failed email error", {
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      break;
    }
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata ?? {};
      if (meta.kind !== "topup") break;
      // Async payment guard: for ACH/SEPA/bank-debit, the session can
      // complete BEFORE the payment actually clears. Stripe sets
      // payment_status === 'unpaid' until the payment succeeds, then
      // fires async_payment_succeeded. Skip granting until paid.
      if (session.payment_status === "unpaid") break;
      const userId = meta.userId;
      const credits = Number(meta.credits);
      if (!userId || !Number.isFinite(credits) || credits <= 0) {
        console.warn(
          `[stripe-webhook] topup checkout missing/invalid metadata: ${session.id}`,
        );
        break;
      }
      await grantTopup({
        userId,
        amount: credits,
        stripeEvent: event.id,
        metadata: {
          session_id: session.id,
          payment_intent: session.payment_intent,
          dollars: meta.dollars,
        },
      });
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      console.warn("[stripe-webhook] async payment failed", {
        eventId: event.id,
        sessionId: session.id,
        kind: session.metadata?.kind,
      });
      // No grant happened (payment never cleared) so nothing to refund.
      // TODO: notify user their bank transfer failed.
      break;
    }
    case "charge.refunded": {
      // Stripe refund (Dashboard or API). Reverse the credit grant.
      // Strategy: look up the credit_ledger row for the topup_purchase
      // tied to this charge's PaymentIntent (we stored payment_intent in
      // the grant's metadata). Refund proportionally for partial refunds.
      // Idempotent on event.id via creditLedger.stripeEvent UNIQUE.
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null;
      if (!paymentIntentId) break;

      // Find the original topup grant ledger entry (newest matching).
      // Drizzle doesn't natively support jsonb path operators in select
      // builder, so we use sql template for the WHERE.
      const [original] = await db
        .select({
          id: creditLedger.id,
          userId: creditLedger.userId,
          delta: creditLedger.delta,
          sessionId: creditLedger.sessionId,
        })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.reason, "topup_purchase"),
            sql`${creditLedger.metadata}->>'payment_intent' = ${paymentIntentId}`,
          ),
        )
        .orderBy(desc(creditLedger.createdAt))
        .limit(1);

      if (!original) {
        console.warn(
          "[stripe-webhook] charge.refunded but no matching topup ledger",
          { eventId: event.id, paymentIntentId },
        );
        break;
      }

      // Compute refund credit amount proportionally (partial refund safe).
      // amount_refunded is in cents; if we charged $20 and refunded $10,
      // we refund half the credits.
      const fraction = charge.amount > 0 ? charge.amount_refunded / charge.amount : 1;
      const refundAmount = Math.floor(original.delta * fraction);
      if (refundAmount <= 0) break;

      // revokeTopupCredits subtracts from the topup bucket (capped at 0
      // — if the user already spent some, we eat the loss). Idempotent
      // on event.id via the credit_ledger UNIQUE index.
      const result = await revokeTopupCredits({
        userId: original.userId,
        amount: refundAmount,
        sessionId: original.sessionId,
        stripeEvent: event.id,
        metadata: {
          charge_id: charge.id,
          payment_intent: paymentIntentId,
          original_ledger_id: original.id,
          refund_fraction: fraction,
          stripe_refund_amount_cents: charge.amount_refunded,
        },
      });
      if (result.revoked) {
        console.info("[stripe-webhook] charge.refunded processed", {
          eventId: event.id,
          userId: original.userId,
          requestedRevoke: refundAmount,
          actuallyDeducted: result.deducted,
          fraction,
        });
      }
      break;
    }
  }
}
