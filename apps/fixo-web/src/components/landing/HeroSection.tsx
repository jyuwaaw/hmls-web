"use client";

import { ArrowRight, Wrench } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/* ── Animated OBD code rain ── */
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
          className="absolute text-[11px] font-mono text-primary/[0.07] font-bold"
          style={{
            left: `${8 + (i % 6) * 16}%`,
            top: `${5 + Math.floor(i / 6) * 45}%`,
            animation: `code-rain ${4 + (i % 3)}s ease-in-out ${i * 0.7}s infinite`,
          }}
        >
          {code}
        </span>
      ))}
    </div>
  );
}

/* ── Inspection Sheet (mechanic inspection report) ── */
const inspectionItems = [
  {
    system: "Brakes",
    item: "Front Brake Pads",
    status: "fail" as const,
    note: "Worn past minimum — 1mm remaining",
    cost: "$150 – $300",
  },
  {
    system: "Brakes",
    item: "Rear Brake Pads",
    status: "warn" as const,
    note: "~30% life remaining",
    cost: null,
  },
  {
    system: "Brakes",
    item: "Rotors",
    status: "warn" as const,
    note: "Light scoring, monitor",
    cost: null,
  },
  {
    system: "Engine",
    item: "Oil Level & Condition",
    status: "pass" as const,
    note: null,
    cost: null,
  },
  {
    system: "Engine",
    item: "Coolant System",
    status: "pass" as const,
    note: null,
    cost: null,
  },
  {
    system: "Suspension",
    item: "Front Struts",
    status: "warn" as const,
    note: "Minor leak detected on driver side",
    cost: "$400 – $700",
  },
  {
    system: "Tires",
    item: "Tread Depth",
    status: "pass" as const,
    note: '6/32" — good',
    cost: null,
  },
];

function InspectionSheet() {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i <= inspectionItems.length; i++) {
      timers.push(setTimeout(() => setVisibleCount(i + 1), 300 + i * 400));
    }
    return () => timers.forEach(clearTimeout);
  }, []);

  const statusIcon = (s: "pass" | "warn" | "fail") =>
    s === "pass" ? "✓" : s === "warn" ? "!" : "✗";
  const statusColor = (s: "pass" | "warn" | "fail") =>
    s === "pass"
      ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
      : s === "warn"
        ? "text-amber-500 bg-amber-500/10 border-amber-500/20"
        : "text-red-500 bg-red-500/10 border-red-500/20";

  const failCount = inspectionItems.filter((i) => i.status === "fail").length;
  const warnCount = inspectionItems.filter((i) => i.status === "warn").length;
  const passCount = inspectionItems.filter((i) => i.status === "pass").length;

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="rounded-xl border border-border/80 bg-card shadow-2xl shadow-black/10 overflow-hidden">
        {/* Header — looks like a real inspection form */}
        <div className="px-5 py-4 bg-muted/50 border-b border-border/60">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="size-6 rounded bg-primary flex items-center justify-center">
                <Wrench className="size-3 text-primary-foreground" />
              </div>
              <span className="text-sm font-bold">
                Fixo<span className="text-primary">.</span> Inspection Report
              </span>
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              #FX-2026-0847
            </span>
          </div>
          <div className="flex gap-4 text-[11px] text-muted-foreground">
            <span>2019 Honda Civic LX</span>
            <span className="text-border">|</span>
            <span>67,420 mi</span>
            <span className="text-border">|</span>
            <span>Mar 8, 2026</span>
          </div>
        </div>

        {/* Inspection items */}
        <div className="divide-y divide-border/40">
          {inspectionItems.map((item, i) => (
            <div
              key={item.item}
              className={`px-5 py-2.5 flex items-start gap-3 transition-opacity duration-250 ${i < visibleCount ? "opacity-100" : "opacity-0"}`}
            >
              <div
                className={`mt-0.5 size-5 rounded border text-[11px] font-bold flex items-center justify-center shrink-0 ${statusColor(item.status)}`}
              >
                {statusIcon(item.status)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{item.item}</span>
                  {item.cost && (
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {item.cost}
                    </span>
                  )}
                </div>
                {item.note && (
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    {item.note}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Summary bar */}
        <div
          className={`px-5 py-3 bg-muted/30 border-t border-border/60 flex items-center justify-between transition-opacity duration-400 ${visibleCount > inspectionItems.length ? "opacity-100" : "opacity-0"}`}
        >
          <div className="flex gap-3 text-[11px] font-mono">
            <span className="text-red-500">{failCount} FAIL</span>
            <span className="text-amber-500">{warnCount} WARN</span>
            <span className="text-emerald-500">{passCount} PASS</span>
          </div>
          <span className="text-[11px] font-mono text-primary">
            Est. Total: $550 – $1,000
          </span>
        </div>
      </div>
    </div>
  );
}

export function HeroSection() {
  return (
    <section className="relative pt-20 pb-24 overflow-hidden">
      <CodeRain />
      <div className="max-w-5xl mx-auto px-6 relative">
        <div className="max-w-2xl mb-14">
          <p className="text-sm font-mono text-primary mb-4 tracking-wide animate-in fade-in duration-400 fill-mode-both">
            AI VEHICLE DIAGNOSTICS
          </p>

          <h1 className="text-[2.5rem] sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] mb-5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both">
            Your mechanic charges $150
            <br />
            to tell you this.
          </h1>

          <p className="text-lg text-muted-foreground max-w-md mb-8 leading-relaxed animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both">
            Snap a photo, record a sound, or just describe what&apos;s wrong.
            Get a real diagnosis in 30 seconds.
          </p>

          <div className="flex gap-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300 fill-mode-both">
            <Link href="/login">
              <Button size="lg" className="h-12 px-6 text-[15px]">
                Try it free
                <ArrowRight className="size-4" />
              </Button>
            </Link>
            <Link href="#how">
              <Button
                variant="outline"
                size="lg"
                className="h-12 px-6 text-[15px]"
              >
                How it works
              </Button>
            </Link>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-3 font-mono animate-in fade-in duration-400 delay-600 fill-mode-both">
            FREE TO START · NO CREDIT CARD · CANCEL IN 2 CLICKS
          </p>
        </div>

        {/* Terminal demo */}
        <div className="animate-in fade-in slide-in-from-bottom-6 duration-600 delay-400 fill-mode-both">
          <InspectionSheet />
        </div>
      </div>
    </section>
  );
}
