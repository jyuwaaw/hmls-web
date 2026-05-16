// hmls-web ↔ fixo推广 CTA helper.
//
// Mirrors the server-side helper in apps/agent/src/lib/notifications.ts —
// emails route through `${FIXO_API_URL}/funnel/track?event=...&to=...`,
// and this file does the same for in-app banners (portal/orders, /estimate)
// when an HMLS order is declined or cancelled. Customer sees a CTA, click
// records `hmls_rejection_click` with the page-specific channel_detail,
// then 302 redirects to fixo.ink.
//
// Two env vars (NEXT_PUBLIC_FIXO_API_URL + NEXT_PUBLIC_FIXO_URL) keep dev
// vs prod targeting parameterizable. Prod defaults are sensible so the
// CTA works zero-config in prod.

const FIXO_PUBLIC_URL = process.env.NEXT_PUBLIC_FIXO_URL || "https://fixo.ink";

const FIXO_API_URL =
  process.env.NEXT_PUBLIC_FIXO_API_URL || "https://api.fixo.hmls.autos";

export function buildFixoCtaUrl(channelDetail: string): string {
  const qs = new URLSearchParams({
    event: "hmls_rejection_click",
    channel: "hmls",
    channel_detail: channelDetail,
    to: FIXO_PUBLIC_URL,
  });
  return `${FIXO_API_URL}/funnel/track?${qs.toString()}`;
}
