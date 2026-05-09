"use client";

import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Clapperboard,
  FileText,
  Gauge,
  MessageSquare,
  Mic,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Footer } from "@/components/landing/Footer";
import { NavBar } from "@/components/landing/NavBar";
import { AnimateInView } from "@/components/ui/animate-in-view";
import { Button } from "@/components/ui/button";
import { AGENT_URL } from "@/lib/config";

/* ── Source-of-truth credit numbers (mirror apps/agent/src/fixo/lib/credits.ts) ── */
const FREE_CREDITS = 200;
const PLUS_CREDITS = 2_000;
const PLUS_PRICE_USD = 19.9;
const TOPUP_CREDITS_PER_DOLLAR = 100;
const SUGGESTED_TOPUPS = [5, 20, 50] as const;

/* Credit cost per input action, from CREDIT_COSTS in credits.ts */
const COSTS = {
  text: 10,
  obd: 10,
  photo: 30,
  audio: 40,
  video: 80,
  report: 100,
} as const;

/* A "full diagnostic" (text intake + 1 photo + 1 OBD + 1 report) ≈ 150 credits.
 * Free covers ~1 (a little tight); Plus covers ~13. We round to the more
 * conservative numbers in the comments to match the credits.ts copy. */
const FULL_DIAGNOSTIC_COST =
  COSTS.text + COSTS.photo + COSTS.obd + COSTS.report;

/* ── Quiet OBD code rain — matches HeroSection ── */
function CodeRain() {
  const codes = [
    "P0420",
    "P0171",
    "P0300",
    "P0442",
    "P0128",
    "B1234",
    "C0035",
    "U0100",
    "P0455",
    "P0401",
    "P0116",
    "P0340",
  ];
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      aria-hidden
    >
      {codes.map((code, i) => (
        <span
          key={code}
          className="absolute text-[11px] font-mono text-primary/[0.06] font-bold"
          style={{
            left: `${6 + (i % 6) * 16}%`,
            top: `${4 + Math.floor(i / 6) * 32}%`,
            animation: `code-rain ${4 + (i % 3)}s ease-in-out ${i * 0.7}s infinite`,
          }}
        >
          {code}
        </span>
      ))}
    </div>
  );
}

/* ── Animated number that counts up when in view ── */
function AnimatedNumber({
  value,
  duration = 900,
  className = "",
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          const tick = (t: number) => {
            const p = Math.min((t - start) / duration, 1);
            // ease-out-quart
            const eased = 1 - (1 - p) ** 4;
            setDisplay(Math.round(eased * value));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      },
      { rootMargin: "-30px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, duration]);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {display.toLocaleString()}
    </span>
  );
}

/* ── Tier card — styled like an inspection-form spec sheet ── */
function TierCard({
  id,
  name,
  tagline,
  price,
  period,
  perCredit,
  credits,
  capacity,
  features,
  cta,
  onCta,
  href,
  recommended,
}: {
  id: string;
  name: string;
  tagline: string;
  price: string;
  period?: string;
  perCredit: string;
  credits: number;
  capacity: string;
  features: string[];
  cta: string;
  onCta?: () => void;
  href?: string;
  recommended?: boolean;
}) {
  const cardClass = recommended
    ? "rounded-xl border-2 border-primary/40 bg-card shadow-2xl shadow-primary/5 overflow-hidden"
    : "rounded-xl border border-border/80 bg-card overflow-hidden";

  const button = (
    <button
      type="button"
      onClick={onCta}
      className={`group/cta inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 text-sm font-medium transition-all ${
        recommended
          ? "bg-primary text-primary-foreground hover:bg-primary-hover"
          : "border border-border bg-background hover:bg-muted"
      }`}
    >
      {cta}
      <ArrowRight className="size-4 transition-transform group-hover/cta:translate-x-0.5" />
    </button>
  );

  return (
    <div className="relative">
      {recommended && (
        <span className="absolute -top-2.5 right-5 z-10 rounded-md bg-primary px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider text-primary-foreground shadow-md shadow-primary/20">
          RECOMMENDED
        </span>
      )}
      <div className={cardClass}>
        {/* Header — looks like an inspection form heading */}
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {name} TIER
          </span>
          <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
            {id}
          </span>
        </div>

        {/* Body */}
        <div className="px-5 pt-5 pb-5">
          <h3 className="text-2xl font-bold tracking-tight">{name}</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{tagline}</p>

          <div className="mt-5 flex items-baseline gap-1">
            <span className="text-5xl font-bold tracking-tight tabular-nums">
              {price}
            </span>
            {period && (
              <span className="text-sm text-muted-foreground">{period}</span>
            )}
          </div>
          <p className="mt-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            {perCredit}
          </p>

          {/* Spec-sheet rows: credits + capacity, with hairline divides */}
          <dl className="mt-5 divide-y divide-border/50 border-y border-border/50">
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Credits
              </dt>
              <dd className="font-mono text-sm font-semibold tabular-nums">
                <AnimatedNumber value={credits} />
                <span className="ml-1 text-muted-foreground">/mo</span>
              </dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                Capacity
              </dt>
              <dd className="font-mono text-[12px] tabular-nums">{capacity}</dd>
            </div>
          </dl>

          {/* Features as inspection-style check rows */}
          <ul className="mt-5 space-y-2">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-[13px]">
                <span
                  className={`mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                    recommended
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <span className="leading-snug text-foreground/90">{f}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6">
            {href ? <Link href={href}>{button}</Link> : button}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Capacity gauge — animated bar showing how many full diagnostics each
 * tier covers. The Free side is a thin sliver, Plus is a full bar — visualizes
 * the 10× allowance claim. ── */
function CapacityGauge() {
  const freeRuns = FREE_CREDITS / FULL_DIAGNOSTIC_COST;
  const plusRuns = PLUS_CREDITS / FULL_DIAGNOSTIC_COST;
  const max = plusRuns;

  return (
    <div className="rounded-xl border border-border/80 bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <Gauge className="size-3.5 text-primary" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
            DIAGNOSTIC CAPACITY
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          PER MONTH
        </span>
      </div>

      <div className="p-5 space-y-5">
        <CapacityRow
          label="Free"
          runs={freeRuns}
          max={max}
          credits={FREE_CREDITS}
          accent={false}
        />
        <CapacityRow
          label="Plus"
          runs={plusRuns}
          max={max}
          credits={PLUS_CREDITS}
          accent
        />

        <p className="border-t border-border/50 pt-4 text-[11px] leading-relaxed text-muted-foreground">
          A <span className="text-foreground">"full diagnostic"</span> here =
          text symptoms + photo + OBD lookup + PDF report ≈
          <span className="ml-1 font-mono font-semibold tabular-nums text-foreground">
            {FULL_DIAGNOSTIC_COST} credits
          </span>
          . Most car problems get solved in one. Audio and video clips cost more
          — full breakdown on the right.
        </p>
      </div>
    </div>
  );
}

function CapacityRow({
  label,
  runs,
  max,
  credits,
  accent,
}: {
  label: string;
  runs: number;
  max: number;
  credits: number;
  accent: boolean;
}) {
  const pct = (runs / max) * 100;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
          ≈
          <span className="ml-1 text-foreground">
            {runs >= 10 ? Math.floor(runs) : runs.toFixed(1)}
          </span>{" "}
          full diagnostics
          <span className="ml-2 text-muted-foreground/70">
            · {credits.toLocaleString()} cr
          </span>
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full border border-border/50 bg-muted/40">
        <AnimateInView
          className="h-full rounded-full"
          animation={
            accent
              ? "animate-in slide-in-from-left-full duration-1000 fill-mode-both"
              : "animate-in slide-in-from-left-full duration-700 fill-mode-both"
          }
        >
          <div
            className={`h-full rounded-full ${accent ? "bg-primary" : "bg-foreground/30"}`}
            style={{ width: `${pct}%` }}
          />
        </AnimateInView>
      </div>
    </div>
  );
}

/* ── Credit cost reference table — shows what each input kind burns ── */
const COST_ROWS = [
  {
    icon: MessageSquare,
    kind: "Text intake",
    cost: COSTS.text,
    note: "describe the symptom",
  },
  {
    icon: Wrench,
    kind: "OBD code",
    cost: COSTS.obd,
    note: "look up DTC + likely cause",
  },
  {
    icon: Camera,
    kind: "Photo",
    cost: COSTS.photo,
    note: "fluid, part, dashboard, etc.",
  },
  {
    icon: Mic,
    kind: "Audio",
    cost: COSTS.audio,
    note: "per 30s · clicks, knocks, whines",
  },
  {
    icon: Clapperboard,
    kind: "Video",
    cost: COSTS.video,
    note: "per 30s · vibration, smoke",
  },
  {
    icon: FileText,
    kind: "PDF report",
    cost: COSTS.report,
    note: "summary + parts + estimate",
  },
] as const;

function CreditCostTable() {
  return (
    <div className="rounded-xl border border-border/80 bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <Zap className="size-3.5 text-primary" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
            CREDIT COSTS
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          PER ACTION
        </span>
      </div>

      <div className="divide-y divide-border/40">
        {COST_ROWS.map(({ icon: Icon, kind, cost, note }) => (
          <div
            key={kind}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/30"
          >
            <span className="flex size-7 items-center justify-center rounded-md border border-border/50 bg-background text-muted-foreground">
              <Icon className="size-3.5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{kind}</p>
              <p className="text-[11px] text-muted-foreground">{note}</p>
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums text-primary">
              {cost}
              <span className="ml-0.5 text-[10px] uppercase text-muted-foreground">
                cr
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Top-up section — explains the $1 = 100cr flat rate, with quick CTAs that
 * deep-link into the chat where the UpgradeModal handles checkout. ── */
function TopupSection() {
  return (
    <div className="rounded-xl border border-border/80 bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
            TOP-UP PACKS
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          NEVER EXPIRES
        </span>
      </div>

      <div className="p-5">
        <h3 className="text-lg font-semibold tracking-tight">
          Heavy week? Top up.
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          No volume games — just{" "}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            $1 = 100 credits
          </span>
          . Top-ups stack on top of your monthly grant and never expire. Buy
          when you need them; ignore otherwise.
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {SUGGESTED_TOPUPS.map((usd) => (
            <Link
              key={usd}
              href={`/chat?topup=${usd}`}
              className="group/pack flex flex-col items-center justify-center rounded-lg border border-border/60 bg-background px-2 py-3 transition-all hover:border-primary/40 hover:bg-primary/[0.03]"
            >
              <span className="font-mono text-lg font-semibold tabular-nums">
                ${usd}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground group-hover/pack:text-primary">
                <Zap className="size-3" />
                {(usd * TOPUP_CREDITS_PER_DOLLAR).toLocaleString()} cr
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── FAQ — collapsible with subtle motion. Inspection-style notes. ── */
const FAQS = [
  {
    q: "What counts as a credit?",
    a: "Every AI action burns credits according to the table above. A short text question is 10cr; a full diagnostic with a photo, OBD code, and PDF report is around 150cr. Audio and video are billed per 30-second block and rounded up.",
  },
  {
    q: "Do unused credits roll over?",
    a: "Monthly credits reset on each grant — what you don't use expires. Top-up credits never expire. Plus's grant fires on each subscription renewal; Free refreshes on a rolling 30-day window.",
  },
  {
    q: "Is there a discount on Plus vs top-ups?",
    a: "No — both clear at $0.01/credit. Plus exists for predictability: auto-renewing 2,000 credits/month so you never have to think about top-ups during a diagnosis.",
  },
  {
    q: "Can I cancel?",
    a: "Anytime from settings. You keep your remaining credits through the end of the billing period; no charge after that.",
  },
  {
    q: "What about refunds?",
    a: "If a diagnosis fails on our side, we refund the credits automatically — they land in your top-up bucket so they don't expire with the next reset.",
  },
];

function FaqRow({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/faq flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <span className="text-sm font-medium leading-snug">{q}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform duration-300 ${
            open ? "rotate-180 text-primary" : ""
          }`}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-4 text-[13px] leading-relaxed text-muted-foreground">
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

function FaqSection() {
  return (
    <div className="rounded-xl border border-border/80 bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
        <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
          FAQ
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {FAQS.length} ENTRIES
        </span>
      </div>
      <div>
        {FAQS.map((f) => (
          <FaqRow key={f.q} {...f} />
        ))}
      </div>
    </div>
  );
}

/* ── Page ── */
export default function PricingPage() {
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);

  const handleUpgrade = async () => {
    if (busy) return;
    if (!session) {
      window.location.href = "/login?next=/pricing";
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${AGENT_URL}/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/chat?upgraded=true`,
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
    } catch (err) {
      console.error("Checkout error:", err);
    }
    setBusy(false);
  };

  const perCreditPlus = (PLUS_PRICE_USD / PLUS_CREDITS).toFixed(4);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <NavBar />

      {/* ── Hero ── */}
      <section className="relative overflow-hidden border-b border-border/40 pt-16 pb-20">
        <CodeRain />
        <div className="relative mx-auto max-w-5xl px-6">
          <p className="mb-4 text-sm font-mono tracking-wide text-primary animate-in fade-in duration-400 fill-mode-both">
            PRICING · NO MYSTERY FEES
          </p>
          <h1 className="mb-5 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both">
            Walk into the shop
            <br />
            already knowing the answer.
          </h1>
          <p className="mb-2 max-w-xl text-lg leading-relaxed text-muted-foreground animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both">
            Snap a photo, record the noise, paste the OBD code — get a real
            diagnosis with parts and labor estimate in 30 seconds. Cheaper than
            the inspection fee, every month, all year.
          </p>
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground/70 animate-in fade-in duration-400 delay-400 fill-mode-both">
            Free to start · No credit card · Cancel in 2 clicks
          </p>
        </div>
      </section>

      {/* ── Tier comparison ── */}
      <section className="border-b border-border/40 bg-muted/20 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <AnimateInView>
              <TierCard
                id="FX-FREE-200"
                name="Free"
                tagline="One full diagnosis on us. No card."
                price="$0"
                perCredit="200 cr / 30-day window"
                credits={FREE_CREDITS}
                capacity={`≈ 1 full diagnostic / mo`}
                features={[
                  "Diagnose by photo, audio, video, or OBD code",
                  "PDF report you can hand any mechanic",
                  "Save every car you own",
                  "Refreshes monthly — keep your account, no card",
                ]}
                cta="Diagnose for Free"
                href="/login"
              />
            </AnimateInView>

            <AnimateInView delay={100}>
              <TierCard
                id="FX-PLUS-2000"
                name="Plus"
                tagline="Less than one shop visit. Lasts all month."
                price="$19.90"
                period="/month"
                perCredit={`$${perCreditPlus} per credit · auto-renews`}
                credits={PLUS_CREDITS}
                capacity={`≈ 13 full diagnostics / mo`}
                features={[
                  "10× more credits — basically unlimited diagnostics",
                  "Top up anytime: $1 = 100 cr, never expires",
                  "Full history of every car, every diagnosis",
                  "Cancel in 2 clicks, keep unused credits this period",
                ]}
                cta={busy ? "Redirecting…" : "Start Plus — $19.90/mo"}
                onCta={handleUpgrade}
                recommended
              />
            </AnimateInView>
          </div>
        </div>
      </section>

      {/* ── How credits work ── */}
      <section className="border-b border-border/40 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <AnimateInView className="mb-10 max-w-2xl">
            <p className="mb-2 text-sm font-mono tracking-wide text-primary">
              HOW IT WORKS
            </p>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Pay only for what you actually do.
            </h2>
            <p className="mt-2 text-muted-foreground">
              A quick text question is 10 credits. A full diagnosis with a
              photo, OBD code, and PDF report is about 150. Audio and video
              count by the 30-second clip — and that's the whole price list.
            </p>
          </AnimateInView>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr]">
            <AnimateInView>
              <CapacityGauge />
            </AnimateInView>
            <AnimateInView delay={100}>
              <CreditCostTable />
            </AnimateInView>
          </div>
        </div>
      </section>

      {/* ── Top-up + FAQ ── */}
      <section className="border-b border-border/40 bg-muted/20 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.3fr]">
            <AnimateInView>
              <TopupSection />
            </AnimateInView>
            <AnimateInView delay={100}>
              <FaqSection />
            </AnimateInView>
          </div>
        </div>
      </section>

      {/* ── Final CTA — economic argument ── */}
      <section className="relative overflow-hidden py-20">
        <CodeRain />
        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <AnimateInView>
            <p className="mb-3 text-sm font-mono tracking-wide text-primary">
              DO THE MATH
            </p>
            <h2 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              <span className="text-muted-foreground line-through decoration-primary/40 decoration-2">
                $150
              </span>{" "}
              for a scan. Once.
              <br />
              Or{" "}
              <span className="font-mono tabular-nums text-primary">
                $19.90
              </span>
              /mo, every month.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              Plus runs the same diagnostic{" "}
              <span className="font-semibold text-foreground">
                ~13 times a month
              </span>{" "}
              — photos, audio, OBD lookups, PDF you can take to any shop. A year
              of second opinions for less than one inspection fee.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Button
                size="lg"
                className="h-12 px-6 text-[15px]"
                onClick={handleUpgrade}
              >
                Start Plus — $19.90/mo
                <ArrowRight className="size-4" />
              </Button>
              <Link href="/login">
                <Button
                  variant="outline"
                  size="lg"
                  className="h-12 px-6 text-[15px]"
                >
                  Try Free First
                </Button>
              </Link>
            </div>
            <p className="mt-4 text-xs font-mono uppercase tracking-wider text-muted-foreground/70">
              No credit card to start · Cancel any time
            </p>
          </AnimateInView>
        </div>
      </section>

      <Footer />
    </div>
  );
}
