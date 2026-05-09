import { getLogger } from "@logtape/logtape";
import { db } from "../db/client.ts";
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
      `Hi ${ctx.customerName},\n\nWe received your decision to decline estimate #${ctx.orderId}. If you change your mind or have questions, feel free to reach out.\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Estimate Declined</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, no problem. If you change your mind or need a revised estimate, just reply to this email or give us a call.
        </p>
      </div>`),
  },

  revised: {
    subject: "Your Revised HMLS Estimate is Ready",
    text: (ctx) =>
      `Hi ${ctx.customerName},\n\nA revised estimate${
        ctx.estimateTotal ? ` (${ctx.estimateTotal})` : ""
      } is ready for your review.\n\n${
        ctx.reviewUrl ?? `${ctx.portalUrl}/orders`
      }\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:24px 24px 16px;">
        <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#18181b;">Revised Estimate Ready</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.5;">
          Hi ${ctx.customerName}, we&apos;ve updated your estimate based on your feedback.
        </p>
      </div>
      ${vehicleBlock(ctx)}
      ${itemsBlock(ctx)}
      ${pricingBlock(ctx)}
      <div style="padding:20px 24px 24px;background:#f9f9fb;border-top:1px solid #e4e4e7;text-align:center;">
        <a href="${
        ctx.reviewUrl ?? ctx.portalUrl
      }" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 36px;border-radius:8px;">Review Revised Estimate</a>
      </div>`),
  },

  scheduled: {
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
      `Hi ${ctx.customerName},\n\nOrder #${ctx.orderId} has been cancelled. If you have questions, please reach out.\n\nThanks,\nHMLS Team`,
    html: (ctx) =>
      htmlWrapper(`
      <div style="padding:32px 24px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#18181b;">Order Cancelled</h1>
        <p style="margin:0;color:#71717a;font-size:14px;line-height:1.6;">
          Hi ${ctx.customerName}, order #${ctx.orderId} has been cancelled. If you have questions or need anything, just reply to this email.
        </p>
      </div>`),
  },
};

// --- Admin notification statuses ---

const ADMIN_NOTIFY_STATUSES = new Set(["approved", "declined", "revised"]);

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

// --- Main notification function ---

export async function notifyOrderStatusChange(
  orderId: number,
  newStatus: string,
): Promise<void> {
  try {
    const [order] = await db
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
      const [customer] = await db
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
        const adminSubject = `[HMLS Admin] Order #${order.id} → ${newStatus}`;
        const adminBody =
          `Order #${order.id} (${customerName} / ${toEmail}) changed to: ${newStatus}\n\nAdmin portal: ${PORTAL_URL}/admin/orders/${order.id}`;
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
