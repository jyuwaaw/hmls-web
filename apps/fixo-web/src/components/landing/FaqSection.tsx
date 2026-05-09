"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { AnimateInView } from "@/components/ui/animate-in-view";
import { LANDING_FAQS } from "./faqs";

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

export function FaqSection() {
  return (
    <section
      id="faq"
      className="border-t border-border/40 bg-muted/20 py-20"
      aria-labelledby="faq-heading"
    >
      <div className="max-w-3xl mx-auto px-6">
        <AnimateInView className="mb-10 text-center">
          <p className="mb-2 text-sm font-mono tracking-wide text-primary">
            FAQ
          </p>
          <h2
            id="faq-heading"
            className="text-3xl sm:text-4xl font-bold tracking-tight"
          >
            Things people ask before signing up.
          </h2>
        </AnimateInView>

        <AnimateInView className="rounded-xl border border-border/80 bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
            <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
              FREQUENTLY ASKED
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {LANDING_FAQS.length} ENTRIES
            </span>
          </div>
          <div>
            {LANDING_FAQS.map((f) => (
              <FaqRow key={f.q} q={f.q} a={f.a} />
            ))}
          </div>
        </AnimateInView>
      </div>
    </section>
  );
}
