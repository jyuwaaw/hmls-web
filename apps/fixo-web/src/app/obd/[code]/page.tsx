// SEO landing pages for the top-5 OBD-II codes by search volume.
//
// Lane C of the fixo Speed Wedge 30-day推广 plan. Generated at build
// time (SSG, NOT force-dynamic) — Next.js prerenders each page once,
// Vercel edge serves it instantly, Google crawls it cheaply.
//
// Page anatomy (information hierarchy = panic user, top-down):
//   1. H1: customer-friendly headline (NOT the technical description)
//   2. Drive-safety verdict badge — "Can I drive?" answered first
//   3. CTA to /chat for 90-second diagnosis (channel-attributed)
//   4. What this code means (description)
//   5. Common root causes
//   6. How a mechanic diagnoses it (pinpoint tests)
//   7. Typical fix cost
//   8. EEAT block (mechanic-authored, anchors HMLS Mobile Mechanics)
//   9. Secondary CTA
//
// JSON-LD: FAQPage schema covers "What does P0420 mean?", "Can I drive
// with P0420?", "How much to fix P0420?". This is what unlocks Google's
// "People also ask" boxes and rich result eligibility.
//
// Funnel: FunnelBeacon (client component) fires `seo_page_view` event
// with `channel='seo'` and `channel_detail=<code>` on mount. Powers the
// D5 kill criteria SQL queries.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EEATBlock } from "@/components/seo/EEATBlock";
import { FunnelBeacon } from "@/components/seo/FunnelBeacon";
import { OBD_SEO_CODES, OBD_SEO_CODES_LIST } from "@/data/obd-seed";
import { SITE_URL } from "@/lib/seo-config";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return OBD_SEO_CODES_LIST.map((entry) => ({ code: entry.code }));
}

interface PageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { code } = await params;
  const entry = OBD_SEO_CODES[code];
  if (!entry) return {};

  const title = `${entry.code}: ${entry.headline}`;
  const description = `${entry.code} — ${entry.description}. ${entry.oneLineVerdict} Diagnosis, common causes, and typical fix cost reviewed by mobile mechanics.`;

  return {
    title,
    description,
    alternates: { canonical: `/obd/${entry.code}` },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/obd/${entry.code}`,
      type: "article",
    },
    twitter: { card: "summary_large_image", title, description },
    keywords: [
      entry.code,
      `${entry.code} meaning`,
      `${entry.code} fix cost`,
      `${entry.code} can I drive`,
      entry.description,
    ],
  };
}

const TIER_BADGE: Record<
  string,
  { label: string; bgClass: string; textClass: string }
> = {
  ok_to_drive: {
    label: "Safe to drive",
    bgClass: "bg-emerald-100 dark:bg-emerald-900/30",
    textClass: "text-emerald-800 dark:text-emerald-300",
  },
  drive_cautiously: {
    label: "Drive cautiously — fix soon",
    bgClass: "bg-amber-100 dark:bg-amber-900/30",
    textClass: "text-amber-800 dark:text-amber-300",
  },
  do_not_drive: {
    label: "Don't drive — get towed",
    bgClass: "bg-red-100 dark:bg-red-900/30",
    textClass: "text-red-800 dark:text-red-300",
  },
};

function priceRange(low: number, high: number): string {
  const fmt = (n: number) => (n === 0 ? "$0" : `$${n.toLocaleString("en-US")}`);
  if (low === high) return fmt(low);
  return `${fmt(low)}–${fmt(high)}`;
}

// Escape `<` inside JSON so the JSON literal can't accidentally close
// the surrounding <script> tag. JSON parsers treat `<` and `<` as
// the same character; structured-data crawlers still parse correctly.
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export default async function ObdCodePage({ params }: PageProps) {
  const { code } = await params;
  const entry = OBD_SEO_CODES[code];
  if (!entry) notFound();

  const badge = TIER_BADGE[entry.driveSafetyTier];

  // FAQPage JSON-LD — unlocks Google's "People also ask" rich results.
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What does ${entry.code} mean?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${entry.code} — ${entry.description}. ${entry.oneLineVerdict}`,
        },
      },
      {
        "@type": "Question",
        name: `Can I drive with ${entry.code}?`,
        acceptedAnswer: { "@type": "Answer", text: entry.oneLineVerdict },
      },
      {
        "@type": "Question",
        name: `How much does it cost to fix ${entry.code}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${priceRange(entry.typicalFixCost.lowUsd, entry.typicalFixCost.highUsd)}. Most common fix: ${entry.typicalFixCost.mostCommonFix}.`,
        },
      },
      {
        "@type": "Question",
        name: `What causes ${entry.code}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: entry.commonRootCauses.slice(0, 3).join("; ") + ".",
        },
      },
    ],
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <FunnelBeacon
        eventName="seo_page_view"
        channel="seo"
        channelDetail={entry.code}
      />

      <script type="application/ld+json">{safeJson(faqJsonLd)}</script>

      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-text-secondary">
        <Link href="/" className="hover:text-text">
          Fixo
        </Link>{" "}
        <span aria-hidden>›</span>{" "}
        <Link href="/obd" className="hover:text-text">
          OBD-II codes
        </Link>{" "}
        <span aria-hidden>›</span>{" "}
        <span className="text-text">{entry.code}</span>
      </nav>

      <header className="mb-6">
        <p className="mb-2 font-mono text-sm uppercase tracking-widest text-text-secondary">
          {entry.code} · {entry.system}
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-text sm:text-4xl">
          {entry.headline}
        </h1>
        <p className="mt-3 text-base text-text-secondary">
          {entry.description}
        </p>
      </header>

      <div
        className={`mb-6 rounded-lg ${badge.bgClass} ${badge.textClass} px-4 py-3`}
      >
        <p className="m-0 text-sm font-semibold">{badge.label}</p>
        <p className="m-0 mt-1 text-sm leading-relaxed">
          {entry.oneLineVerdict}
        </p>
      </div>

      <Link
        href={`/chat?utm_source=seo&utm_campaign=obd_${entry.code}`}
        className="mb-10 inline-flex items-center justify-center rounded-md bg-red-primary px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-red-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-red-primary focus-visible:ring-offset-2"
      >
        Get a 90-second AI diagnosis →
      </Link>

      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-text">Common causes</h2>
        <ul className="list-disc space-y-2 pl-6 text-text-secondary">
          {entry.commonRootCauses.map((cause) => (
            <li key={cause}>{cause}</li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-text">
          How a mechanic diagnoses it
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-text-secondary">
          {entry.pinpointTests.map((test) => (
            <li key={test}>{test}</li>
          ))}
        </ol>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xl font-semibold text-text">
          Typical fix cost
        </h2>
        <p className="m-0 text-text-secondary">
          <span className="text-xl font-bold text-text">
            {priceRange(
              entry.typicalFixCost.lowUsd,
              entry.typicalFixCost.highUsd,
            )}
          </span>{" "}
          — most common fix: {entry.typicalFixCost.mostCommonFix}. Actual cost
          varies by vehicle year/make and local labor rates; Fixo's AI estimate
          adjusts for both.
        </p>
      </section>

      <EEATBlock />

      <section className="rounded-lg bg-surface-alt p-6 text-center">
        <h2 className="m-0 mb-2 text-lg font-semibold text-text">
          Want a real diagnosis right now?
        </h2>
        <p className="m-0 mb-4 text-sm text-text-secondary">
          Paste {entry.code} into Fixo's AI, add your vehicle, and get a
          car-specific answer in under 90 seconds. Free to start.
        </p>
        <Link
          href={`/chat?utm_source=seo&utm_campaign=obd_${entry.code}&utm_content=footer_cta`}
          className="inline-flex items-center justify-center rounded-md bg-red-primary px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-red-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-red-primary focus-visible:ring-offset-2"
        >
          Diagnose {entry.code} for free →
        </Link>
      </section>
    </main>
  );
}
