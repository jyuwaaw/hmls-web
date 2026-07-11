import { getLogger } from "@logtape/logtape";
import { dbAdmin } from "../db/client.ts";
import * as schema from "@hmls/shared/db/schema";
import { eq } from "drizzle-orm";

const logger = getLogger(["hmls", "agent", "notifications"]);

// --- Types ---

// Trimmed-down item shape used only for rendering email rows. Maps from
// the canonical OrderItem in @hmls/shared/db/schema; we collapse the
// labor/parts split into a single `price` (totalCents) for display.
interface NotificationItem {
  name: string;
  description?: string;
  price: number; // cents (= canonical OrderItem.totalCents)
}

interface NotificationContext {
  customerName: string;
  orderId: number;
  estimateTotal?: string;
  quoteTotal?: string;
  baseUrl: string;
  portalUrl: string;
  reviewUrl?: string;
  vehicleInfo?: { year?: string; make?: string; model?: string } | null;
  items?: NotificationItem[];
  priceRangeLow?: number; // cents
  priceRangeHigh?: number; // cents
  subtotal?: number; // cents
  expiresAt?: string;
}

interface EmailTemplate {
  subject: string;
  text: (ctx: NotificationContext) => string;
  html?: (ctx: NotificationContext) => string;
}

// --- Config ---

const BASE_URL = Deno.env.get("BASE_URL") || "https://hmls.autos";
const PORTAL_URL = Deno.env.get("PORTAL_URL") || `${BASE_URL}/portal`;
const BUSINESS_ADDRESS = Deno.env.get("BUSINESS_ADDRESS") ?? "";

// Fixo推广 CTA targets (CEO plan 2026-05-14 Lane D — HMLS rejection
// flow becomes fixo's first dogfood channel). The CTA in rejection /
// cancellation emails routes through the fixo gateway's
// /funnel/track GET endpoint so we capture the click before the
// browser leaves for fixo.ink, then redirects to FIXO_PUBLIC_URL.
const FIXO_PUBLIC_URL = Deno.env.get("FIXO_PUBLIC_URL") || "https://fixo.ink";
const FIXO_API_URL = Deno.env.get("FIXO_API_URL") || "https://api.fixo.ink";

if (!BUSINESS_ADDRESS) {
  logger.warn(
    "BUSINESS_ADDRESS env var not set — outgoing emails will lack the physical address required by CAN-SPAM",
  );
}

// --- HTML helpers ---

function fmtCents(cents: number): string {
  return "$" +
    (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function vehicleBlock(ctx: NotificationContext): string {
  const v = ctx.vehicleInfo;
  if (!v || (!v.year && !v.make && !v.model)) return "";
  const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return `
    <div style="margin:0 24px 16px;padding:12px 16px;background:#f4f4f5;border-radius:8px;border:1px solid #e4e4e7;">
      <span style="font-size:13px;color:#52525b;">&#128663; ${label}</span>
    </div>`;
}

function itemsBlock(ctx: NotificationContext): string {
  const items = ctx.items;
  if (!items || items.length === 0) return "";
  const rows = items.map((item) => `
    <tr>
      <td style="padding:12px 24px;border-bottom:1px solid #f4f4f5;vertical-align:top;">
        <div style="font-size:14px;font-weight:600;color:#18181b;">${item.name}</div>
        ${
    item.description
      ? `<div style="font-size:12px;color:#71717a;margin-top:2px;">${item.description}</div>`
      : ""
  }
      </td>
      <td style="padding:12px 24px;border-bottom:1px solid #f4f4f5;text-align:right;white-space:nowrap;vertical-align:top;">
        <span style="font-size:14px;font-weight:600;color:#18181b;">${fmtCents(item.price)}</span>
      </td>
    </tr>`).join("");
  return `
    <div style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
      <div style="padding:10px 24px;background:#f9f9fb;">
        <span style="font-size:11px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Services</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </div>`;
}

function pricingBlock(ctx: NotificationContext): string {
  const hasRange = ctx.priceRangeLow && ctx.priceRangeHigh;
  const hasSubtotal = ctx.subtotal && ctx.subtotal > 0;
  if (!hasRange && !hasSubtotal) return "";
  return `
    <div style="padding:16px 24px;">
      ${
    hasSubtotal
      ? `
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-size:13px;color:#71717a;padding-bottom:8px;">Subtotal</td>
            <td style="font-size:13px;color:#18181b;text-align:right;padding-bottom:8px;">${
        fmtCents(ctx.subtotal!)
      }</td>
          </tr>
        </table>`
      : ""
  }
      ${
    hasRange
      ? `
        <div style="border-top:1px solid #e4e4e7;padding-top:10px;margin-top:${
        hasSubtotal ? "0" : "0"
      }">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-size:15px;font-weight:700;color:#18181b;">Estimated Range</td>
              <td style="font-size:15px;font-weight:700;color:#18181b;text-align:right;">${
        fmtCents(ctx.priceRangeLow!)
      } &ndash; ${fmtCents(ctx.priceRangeHigh!)}</td>
            </tr>
          </table>
          <p style="margin:6px 0 0;font-size:11px;color:#a1a1aa;">Final pricing confirmed in your official quote.</p>
        </div>`
      : ""
  }
    </div>`;
}

function fixoCtaUrl(channelDetail: string): string {
  // GET /funnel/track records the click then 302s to FIXO_PUBLIC_URL.
  // channel='hmls' is fixed for all rejection-side CTAs; channelDetail
  // disambiguates which template fired the click (cancelled / declined).
  const qs = new URLSearchParams({
    event: "hmls_rejection_click",
    channel: "hmls",
    channel_detail: channelDetail,
    to: FIXO_PUBLIC_URL,
  });
  return `${FIXO_API_URL}/funnel/track?${qs.toString()}`;
}

// Subtle "by the way, here's a free tool" CTA. Honest, not over-sell —
// the customer just heard "we're done" or "we can't help". Pushy copy
// would harm HMLS's brand. The CTA is a single understated paragraph
// with a low-emphasis link, NOT a prominent button.
function fixoFreeCtaBlock(channelDetail: string): string {
  return `
    <div style="padding:18px 24px;border-top:1px solid #f4f4f5;background:#fafafa;">
      <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">
        If you want a second opinion before you call another shop, we built
        a free AI tool for that: <a href="${
    fixoCtaUrl(channelDetail)
  }" style="color:#18181b;text-decoration:underline;">fixo.ink</a>.
        It listens to engine sounds and reads OBD codes — 90-second answer,
        no signup wall.
      </p>
    </div>`;
}

function htmlWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:0;">
  <!-- Header -->
  <div style="background:#18181b;padding:20px 32px;">
    <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">HMLS</span>
  </div>
  <!-- Card -->
  <div style="max-width:560px;margin:0 auto;padding:20px 16px;">
    <div style="background:#ffffff;border-radius:12px;border:1px solid #e4e4e7;overflow:hidden;">
      ${content}
    </div>
    <p style="text-align:center;font-size:11px;color:#a1a1aa;margin:16px 0;line-height:1.5;">HMLS &middot; <a href="${BASE_URL}" style="color:#a1a1aa;">${
    BASE_URL.replace("https://", "")
  }</a>${BUSINESS_ADDRESS ? `<br>${BUSINESS_ADDRESS}` : ""}</p>
  </div>
</td></tr>
</table>
</body>
</html>`;
}

// --- Email templates ---

const STATUS_EMAILS: Record<string, EmailTemplate> = {
  estimated: {
    subject: "Your HMLS Estimate is Ready",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nYour estimate${
        ctx.estimateTotal ? ` (${ctx.estimateTotal})` : ""
      } is ready for review.\n\nView and approve:\n${
        ctx.reviewUrl ?? `${ctx.portalUrl}/orders`
      }\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:24px 24px 16px;">
        <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#18181b;line-height:1.3;">Your Estimate is Ready</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.5;">
          Hi ${ctx.customerName}, here&apos;s your service estimate. Review and approve when you&apos;re ready.
        </p>
      </div>
      ${vehicleBlock(ctx)}
      ${itemsBlock(ctx)}
      ${pricingBlock(ctx)}
      <div style="padding:20px 24px 24px;background:#f9f9fb;border-top:1px solid #e4e4e7;text-align:center;">
        <a href="${
        ctx.reviewUrl ?? ctx.portalUrl
      }" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 36px;border-radius:8px;letter-spacing:-0.2px;">Approve Estimate</a>
        <br>
        <a href="${
        ctx.reviewUrl ?? ctx.portalUrl
      }" style="display:inline-block;margin-top:12px;color:#71717a;font-size:13px;text-decoration:none;">View &amp; Decline</a>
        ${
        ctx.expiresAt
          ? `<p style="margin:14px 0 0;font-size:11px;color:#a1a1aa;">This estimate expires on ${
            fmtDate(ctx.expiresAt)
          }.</p>`
          : ""
      }
      </div>`),
  },

  approved: {
    subject: "Estimate Approved — We'll Schedule Your Service",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nThanks for approving your estimate! We'll assign a mechanic and confirm your appointment, then email you the details.\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <div style="width:56px;height:56px;background:#dcfce7;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
          <span style="font-size:24px;">&#10003;</span>
        </div>
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Estimate Approved</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, thanks for approving! We&apos;ll assign a mechanic and confirm your appointment, then email you the details.
        </p>
      </div>`),
  },

  declined: {
    subject: "Estimate Declined",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nWe received your decision to decline estimate #${ctx.orderId}. If you change your mind or have questions, feel free to reach out.\n\nIf you want a second opinion before you call another shop, fixo.ink is a free AI diagnostic — 90-second answer. ${
        fixoCtaUrl("declined")
      }\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Estimate Declined</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, no problem. If you change your mind or need a revised estimate, just reply to this email or give us a call.
        </p>
      </div>
      ${fixoFreeCtaBlock("declined")}`),
  },

  // NOT a status: fired via the schedule_ready_notified event when the
  // slot+mechanic pair first becomes complete on an approved order (there
  // is no `scheduled` status after the 9→7 collapse). Content unchanged
  // from the old →scheduled template.
  schedule_ready: {
    subject: "Your HMLS Service is Scheduled",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nYour service appointment is confirmed. View details:\n${ctx.portalUrl}/orders\n\nSee you soon!\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Service Scheduled</h1>
        <p style="margin:0 0 20px;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, your appointment is confirmed. View the details in your portal.
        </p>
        <a href="${ctx.portalUrl}/orders" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 36px;border-radius:8px;">View Details</a>
      </div>`),
  },

  // NOT a status: reschedule of an already-confirmed booking (time changed).
  schedule_changed: {
    subject: "Your HMLS Appointment Time Has Changed",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nYour service appointment time has been updated. View the new details:\n${ctx.portalUrl}/orders\n\nSee you soon!\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Appointment Time Changed</h1>
        <p style="margin:0 0 20px;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, your appointment time has been updated. View the new details in your portal.
        </p>
        <a href="${ctx.portalUrl}/orders" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 36px;border-radius:8px;">View Details</a>
      </div>`),
  },

  in_progress: {
    subject: "Your Service is In Progress",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nOur technician has started working on your vehicle. We'll update you when the work is complete.\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Work in Progress</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, our technician has started on your vehicle. We&apos;ll email you as soon as it&apos;s done.
        </p>
      </div>`),
  },

  completed: {
    subject: "Your HMLS Service is Complete",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nYour service is complete! View your receipt:\n${ctx.portalUrl}/orders\n\nThank you for choosing HMLS!\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <div style="width:56px;height:56px;background:#dcfce7;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
          <span style="font-size:24px;">&#10003;</span>
        </div>
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Service Complete</h1>
        <p style="margin:0 0 20px;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, your vehicle is ready for pickup! View your receipt and service summary in your portal.
        </p>
        <a href="${ctx.portalUrl}/orders" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 36px;border-radius:8px;">View Receipt</a>
        <p style="margin:16px 0 0;font-size:13px;color:#71717a;">Thank you for choosing HMLS!</p>
      </div>`),
  },

  cancelled: {
    subject: "Your HMLS Order Has Been Cancelled",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nOrder #${ctx.orderId} has been cancelled. If you have questions, please reach out.\n\nIf you still need the work done and want a quick second opinion, fixo.ink is a free AI diagnostic. ${
        fixoCtaUrl("cancelled")
      }\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Order Cancelled</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, order #${ctx.orderId} has been cancelled. If you have questions or need anything, just reply to this email.
        </p>
      </div>
      ${fixoFreeCtaBlock("cancelled")}`),
  },
};

// --- Admin notification statuses ---

// `draft` here means the estimated→draft pullback (an already-sent estimate
// was withdrawn for revision) — the only way `draft` arrives via a status
// change. New AI drafts are created directly, never through transition(),
// so they don't trigger this.
const ADMIN_NOTIFY_STATUSES = new Set(["approved", "declined", "draft"]);

/** Human wording for the admin subject line — the raw status alone is
 *  cryptic for the pullback case. */
function adminStatusLabel(newStatus: string): string {
  return newStatus === "draft" ? "pulled back to draft (revision in progress)" : newStatus;
}

// --- Email sending via Resend ---

async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set — skipping email to {to}: {subject}", {
      to,
      subject,
    });
    return false;
  }

  const from = Deno.env.get("NOTIFY_FROM_EMAIL") || "HMLS <noreply@hmls.autos>";

  try {
    const body: Record<string, unknown> = { from, to: [to], subject, text };
    if (html) body.html = html;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error("Resend error {status}: {errBody}", {
        status: res.status,
        errBody,
        to,
        subject,
      });
      return false;
    }

    logger.info("Email sent to {to}: {subject}", { to, subject });
    return true;
  } catch (err) {
    logger.error("Failed to send email", {
      to,
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// --- Billing notifications ---

/**
 * Notify a Plus/Pro subscriber that their card payment failed. Stripe
 * retries automatically (smart retries / dunning); this email lets the
 * user fix their card before the subscription cancels. No-op if RESEND
 * isn't configured.
 */
export async function notifyPaymentFailed(opts: {
  toEmail: string;
  attempt: number;
  nextRetryAt?: Date | null;
  manageBillingUrl: string;
}): Promise<boolean> {
  const subject = "Your Fixo payment failed";
  const retryLine = opts.nextRetryAt
    ? `Stripe will retry on ${opts.nextRetryAt.toLocaleDateString()}.`
    : "Stripe will retry shortly.";
  const text = [
    `Hi,`,
    ``,
    `Your most recent Fixo payment couldn't be processed (attempt ${opts.attempt}).`,
    retryLine,
    ``,
    `To avoid losing your Plus features, please update your card here:`,
    opts.manageBillingUrl,
    ``,
    `If your subscription cancels, your existing credits stay usable —`,
    `you just won't get next month's grant.`,
    ``,
    `— Fixo`,
  ].join("\n");
  return await sendEmail(opts.toEmail, subject, text);
}

// --- Mechanic notifications ---

export type MechanicNotifyEvent = "assigned" | "rescheduled" | "cancelled" | "unassigned";

/** Outcome of recipient resolution — returned so callers/tests can see which
 *  path was taken without inspecting logs. "sent" = a provider email was
 *  resolved and dispatched to sendEmail (dispatch success depends on Resend
 *  config, which is orthogonal). */
export type MechanicNotifyResult = "sent" | "no-recipient" | "not-found";

/** Email a mechanic when their job is assigned, rescheduled, cancelled, or
 *  reassigned away from them. Self-contained recipient resolution like
 *  notifyOrderStatusChange: resolves an email via Resend. The recipient is the
 *  order's current mechanic (order.providerId) unless `recipientProviderId` is
 *  given — reassignment passes the PREVIOUS provider's id there to reach the
 *  mechanic being taken off. No-op (logged) when there's no target mechanic or
 *  they have no email on file. Called fire-and-forget from the order-state
 *  mutation points — a send failure never affects the committed DB write. */
export async function notifyMechanic(
  orderId: number,
  event: MechanicNotifyEvent,
  recipientProviderId?: number,
): Promise<MechanicNotifyResult> {
  try {
    const [order] = await dbAdmin
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);

    if (!order) {
      logger.warn("notifyMechanic: order {orderId} not found", { orderId });
      return "not-found";
    }
    const targetProviderId = recipientProviderId ?? order.providerId;
    if (targetProviderId == null) return "no-recipient"; // no mechanic to notify

    const [provider] = await dbAdmin
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.id, targetProviderId))
      .limit(1);

    if (!provider?.email) {
      logger.warn("notifyMechanic: no email for provider {providerId} on order {orderId}", {
        orderId,
        providerId: targetProviderId,
      });
      return "no-recipient";
    }

    const vehicle = order.vehicleInfo
      ? [order.vehicleInfo.year, order.vehicleInfo.make, order.vehicleInfo.model]
        .filter(Boolean).join(" ")
      : "";
    const work = (order.items ?? []).map((i) => i.name).filter(Boolean).join(", ");
    const when = order.scheduledAt
      ? order.scheduledAt.toLocaleString("en-US", {
        timeZone: provider.timezone,
        dateStyle: "full",
        timeStyle: "short",
      })
      : "Time TBD";
    const customer = order.contactName || "Customer";
    const phone = order.contactPhone || "";
    const jobsUrl = `${BASE_URL}/mechanic`;

    let subject: string;
    let intro: string;
    const lines: string[] = [];
    switch (event) {
      case "assigned":
        subject = `New job assigned — Order #${orderId}`;
        intro = "You've been assigned a new job.";
        break;
      case "rescheduled":
        subject = `Appointment time updated — Order #${orderId}`;
        intro = "The appointment time for one of your jobs was updated.";
        break;
      case "cancelled":
        subject = `Job cancelled — Order #${orderId}`;
        intro = "A job assigned to you was cancelled — you don't need to go.";
        break;
      case "unassigned":
        subject = `Removed from job — Order #${orderId}`;
        intro = "You've been taken off this job — it's been reassigned to another mechanic.";
        break;
    }

    // "cancelled" / "unassigned" mechanics aren't going — skip the when/where/
    // customer block that only makes sense for someone who still has the job.
    const stillGoing = event === "assigned" || event === "rescheduled";
    lines.push(intro, "", `Order #${orderId}`);
    if (vehicle) lines.push(`Vehicle: ${vehicle}`);
    if (work) lines.push(`Work: ${work}`);
    if (stillGoing) {
      lines.push(`When: ${when}`);
      if (order.location) lines.push(`Where: ${order.location}`);
      lines.push(`Customer: ${customer}${phone ? ` (${phone})` : ""}`);
    }
    lines.push("", `Your jobs: ${jobsUrl}`);

    await sendEmail(provider.email, subject, lines.join("\n"));
    return "sent";
  } catch (err) {
    logger.error("notifyMechanic failed for order {orderId}", {
      orderId,
      event,
      error: err instanceof Error ? err.message : String(err),
    });
    return "not-found";
  }
}

// --- Main notification function ---

/** Send the customer (and possibly admin) email for an order lifecycle
 *  moment. `newStatus` is either a canonical order status or one of the
 *  schedule-event template keys ("schedule_ready" / "schedule_changed") —
 *  both index into STATUS_EMAILS / ADMIN_NOTIFY_STATUSES the same way. */
export async function notifyOrderStatusChange(
  orderId: number,
  newStatus: string,
): Promise<void> {
  try {
    // Fire-and-forget (see order-state.ts caller) — runs after the caller's
    // transaction has committed, so the ALS-bound tx (and its tenant GUC) is
    // gone. Read-only system lookup for an order already authorized upstream.
    const [order] = await dbAdmin
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);

    if (!order) {
      logger.warn("Order {orderId} not found", { orderId });
      return;
    }

    // Use contactEmail snapshot first, fall back to customer record
    let toEmail = order.contactEmail ?? null;
    let customerName = order.contactName || "there";

    if (!toEmail && order.customerId) {
      const [customer] = await dbAdmin
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, order.customerId))
        .limit(1);

      if (!customer?.email) {
        logger.warn("No email for order {orderId} / customer {customerId}", {
          orderId,
          customerId: order.customerId,
        });
        return;
      }
      toEmail = customer.email;
      customerName = customer.name || order.contactName || "there";
    }

    if (!toEmail) {
      logger.warn("No email for order {orderId} — no customer linked", { orderId });
      return;
    }

    const ctx: NotificationContext = {
      customerName,
      orderId: order.id,
      baseUrl: BASE_URL,
      portalUrl: PORTAL_URL,
    };

    // Pricing
    if (order.priceRangeLowCents && order.priceRangeHighCents) {
      ctx.priceRangeLow = order.priceRangeLowCents;
      ctx.priceRangeHigh = order.priceRangeHighCents;
      ctx.estimateTotal = `${fmtCents(order.priceRangeLowCents)}–${
        fmtCents(order.priceRangeHighCents)
      }`;
    } else if (order.subtotalCents) {
      ctx.estimateTotal = fmtCents(order.subtotalCents);
    }

    if (order.subtotalCents) {
      ctx.subtotal = order.subtotalCents;
      ctx.quoteTotal = (order.subtotalCents / 100).toFixed(2);
    }

    // Items & vehicle for rich email
    if (order.items) {
      ctx.items = order.items.map((item) => ({
        name: item.name,
        description: item.description,
        price: item.totalCents,
      }));
    }
    if (order.vehicleInfo) {
      ctx.vehicleInfo = order.vehicleInfo as NotificationContext["vehicleInfo"];
    }
    if (order.expiresAt) {
      ctx.expiresAt = order.expiresAt.toISOString();
    }

    // Magic link: points to /estimate/[id] (no /portal prefix)
    if (order.shareToken) {
      ctx.reviewUrl = `${BASE_URL}/estimate/${order.id}?token=${order.shareToken}`;
    }

    // Send customer email
    const template = STATUS_EMAILS[newStatus];
    if (template) {
      const html = template.html ? template.html(ctx) : undefined;
      const textFooter = BUSINESS_ADDRESS ? `\n\n--\n${BUSINESS_ADDRESS}` : "";
      await sendEmail(toEmail, template.subject, template.text(ctx) + textFooter, html);
    }

    // Notify admin for certain statuses
    if (ADMIN_NOTIFY_STATUSES.has(newStatus)) {
      const adminEmail = Deno.env.get("ADMIN_NOTIFY_EMAIL");
      if (adminEmail) {
        const label = adminStatusLabel(newStatus);
        const adminSubject = `[HMLS Admin] Order #${order.id} → ${label}`;
        const adminBody =
          `Order #${order.id} (${customerName} / ${toEmail}) changed to: ${label}\n\nAdmin portal: ${PORTAL_URL}/admin/orders/${order.id}`;
        await sendEmail(adminEmail, adminSubject, adminBody);
      }
    }
  } catch (err) {
    logger.error("Error for order {orderId}", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
