// Stripe ↔ ledger reconciliation report.
//
// Detects drift between money Stripe collected and credits we granted.
// Run on demand:  deno run -A apps/agent/src/fixo/scripts/reconcile-credits.ts
// Or wire as a daily cron later.
//
// What it checks (current calendar month by default):
//   1. Stripe paid invoices (subscription renewals) → expect a
//      subscription_grant ledger row per invoice with delta matching
//      MONTHLY_GRANT[user.tier].
//   2. Stripe completed Checkout sessions (mode=payment, kind=topup) →
//      expect a topup_purchase ledger row matching `dollars * 100` credits.
//   3. Stripe refunded charges → expect a refund ledger row referencing
//      the same payment_intent.
//
// Reports drift as a structured table. Exit code 0 if clean, 1 if drift.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { stripe } from "../lib/stripe.ts";
import { MONTHLY_GRANT } from "../lib/credits.ts";

const { creditLedger, userProfiles } = schema;

interface DriftRow {
  kind: "missing_grant" | "missing_topup" | "missing_refund" | "amount_mismatch";
  stripeId: string;
  customerId?: string;
  expected?: number;
  actual?: number;
  notes?: string;
}

function monthStart(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

async function checkSubscriptionGrants(since: Date): Promise<DriftRow[]> {
  const drift: DriftRow[] = [];
  // Walk all paid subscription invoices in window. Pagination via
  // auto_paging_iterator (Stripe SDK helper).
  for await (
    const invoice of stripe.invoices.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      status: "paid",
      limit: 100,
    })
  ) {
    // deno-lint-ignore no-explicit-any
    const subscriptionId = (invoice as any).subscription as
      | string
      | { id: string }
      | null
      | undefined;
    if (!subscriptionId) continue;

    const customerId = invoice.customer as string;
    const [profile] = await db
      .select({ id: userProfiles.id, tier: userProfiles.tier })
      .from(userProfiles)
      .where(eq(userProfiles.stripeCustomerId, customerId))
      .limit(1);

    if (!profile) {
      drift.push({
        kind: "missing_grant",
        stripeId: invoice.id ?? "",
        customerId,
        notes: "no user_profile matches stripe_customer_id",
      });
      continue;
    }
    if (profile.tier === "free") continue;

    const expected = MONTHLY_GRANT[profile.tier];

    // Look for a subscription_grant ledger row for this user dated near
    // the invoice's payment time (within 1 day).
    const invoiceTs = new Date(
      invoice.status_transitions?.paid_at
        ? invoice.status_transitions.paid_at * 1000
        : invoice.created * 1000,
    );
    const dayBefore = new Date(invoiceTs.getTime() - 24 * 60 * 60 * 1000);
    const dayAfter = new Date(invoiceTs.getTime() + 24 * 60 * 60 * 1000);

    const [match] = await db
      .select({ delta: creditLedger.delta })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, profile.id),
          eq(creditLedger.reason, "subscription_grant"),
          gte(creditLedger.createdAt, dayBefore),
          sql`${creditLedger.createdAt} <= ${dayAfter}`,
        ),
      )
      .orderBy(desc(creditLedger.createdAt))
      .limit(1);

    if (!match) {
      drift.push({
        kind: "missing_grant",
        stripeId: invoice.id ?? "",
        customerId,
        expected,
        notes: `no subscription_grant within 24h of invoice ${invoice.id}`,
      });
    } else if (match.delta !== expected) {
      drift.push({
        kind: "amount_mismatch",
        stripeId: invoice.id ?? "",
        customerId,
        expected,
        actual: match.delta,
        notes: `subscription_grant delta != MONTHLY_GRANT[${profile.tier}]`,
      });
    }
  }
  return drift;
}

async function checkTopupGrants(since: Date): Promise<DriftRow[]> {
  const drift: DriftRow[] = [];
  for await (
    const session of stripe.checkout.sessions.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    })
  ) {
    if (session.mode !== "payment") continue;
    if (session.metadata?.kind !== "topup") continue;
    if (session.payment_status === "unpaid") continue;
    const expectedCredits = Number(session.metadata.credits ?? 0);
    if (!Number.isFinite(expectedCredits) || expectedCredits <= 0) continue;
    const piId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
    if (!piId) continue;

    const [match] = await db
      .select({ delta: creditLedger.delta })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.reason, "topup_purchase"),
          sql`${creditLedger.metadata}->>'payment_intent' = ${piId}`,
        ),
      )
      .limit(1);

    if (!match) {
      drift.push({
        kind: "missing_topup",
        stripeId: session.id,
        expected: expectedCredits,
        notes: `topup checkout completed but no topup_purchase ledger`,
      });
    } else if (match.delta !== expectedCredits) {
      drift.push({
        kind: "amount_mismatch",
        stripeId: session.id,
        expected: expectedCredits,
        actual: match.delta,
        notes: `topup_purchase delta != metadata.credits`,
      });
    }
  }
  return drift;
}

async function checkRefunds(since: Date): Promise<DriftRow[]> {
  const drift: DriftRow[] = [];
  // Charges with any amount_refunded in window.
  for await (
    const charge of stripe.charges.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    })
  ) {
    if (charge.amount_refunded <= 0) continue;
    const piId = typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;
    if (!piId) continue;

    const [match] = await db
      .select({ delta: creditLedger.delta })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.reason, "refund"),
          sql`${creditLedger.metadata}->>'payment_intent' = ${piId}`,
        ),
      )
      .limit(1);

    if (!match) {
      drift.push({
        kind: "missing_refund",
        stripeId: charge.id,
        notes: `charge refunded $${
          (charge.amount_refunded / 100).toFixed(2)
        } but no refund ledger row`,
      });
    }
  }
  return drift;
}

async function main(): Promise<void> {
  const since = monthStart();
  console.log(`Reconciling Stripe ↔ ledger since ${since.toISOString()}\n`);

  const [grantDrift, topupDrift, refundDrift] = await Promise.all([
    checkSubscriptionGrants(since),
    checkTopupGrants(since),
    checkRefunds(since),
  ]);

  const allDrift = [...grantDrift, ...topupDrift, ...refundDrift];

  if (allDrift.length === 0) {
    console.log("✓ No drift detected. Stripe ↔ ledger fully aligned.");
    Deno.exit(0);
  }

  console.log(`✗ Drift detected: ${allDrift.length} issue(s)\n`);
  for (const row of allDrift) {
    console.log(
      `  [${row.kind}] ${row.stripeId}` +
        (row.customerId ? ` (cus ${row.customerId})` : "") +
        (row.expected !== undefined ? ` expected=${row.expected}` : "") +
        (row.actual !== undefined ? ` actual=${row.actual}` : "") +
        (row.notes ? `\n    ${row.notes}` : ""),
    );
  }
  Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
