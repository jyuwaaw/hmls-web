import { buildFixoCtaUrl } from "@/lib/fixo-cta";

interface FixoCtaBannerProps {
  /**
   * Disambiguator for the channel_detail funnel-event column. Examples:
   * "portal_declined", "portal_cancelled", "estimate_declined".
   * Lets the kill-criteria SQL queries distinguish which surface drove
   * the click without parsing referrer headers.
   */
  channelDetail: string;
}

// Subtle "by the way, here's a free tool" banner. Mirrors the email
// CTA copy in apps/agent/src/lib/notifications.ts so the customer
// experience is consistent whether they arrive via email or land on
// the page directly.
//
// Tone is deliberately non-pushy — the customer just got told "no",
// or just declined an estimate themselves. Aggressive copy here would
// hurt the HMLS brand. Low-emphasis link, not a prominent button.
export function FixoCtaBanner({ channelDetail }: FixoCtaBannerProps) {
  return (
    <aside
      aria-label="Free second opinion"
      className="mt-6 rounded-lg border border-border bg-surface-alt px-4 py-3"
    >
      <p className="m-0 text-sm leading-relaxed text-text-secondary">
        Want a quick second opinion before you call another shop? We built a
        free AI tool for that:{" "}
        <a
          href={buildFixoCtaUrl(channelDetail)}
          className="font-medium text-text underline decoration-text-secondary/40 underline-offset-4 hover:decoration-text"
        >
          fixo.ink
        </a>{" "}
        listens to engine sounds and reads OBD codes — 90-second answer, no
        signup wall.
      </p>
    </aside>
  );
}
