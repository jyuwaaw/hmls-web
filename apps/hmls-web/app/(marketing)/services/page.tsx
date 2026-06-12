import { Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { FadeIn } from "@/components/ui/Animations";
import { BUSINESS } from "@/lib/business";
import { breadcrumbSchema } from "@/lib/schema";
import { SERVICES } from "@/lib/seo-content";

export const metadata: Metadata = {
  title: "Services — Mobile Mechanic San Jose & Orange County",
  description: `Full mobile mechanic services in San Jose, the South Bay, and Orange County: oil changes, brake repair, batteries, diagnostics, and pre-purchase inspections. Call ${BUSINESS.phoneDisplay}.`,
  alternates: { canonical: `${BUSINESS.url}/services` },
};

export default function ServicesIndex() {
  return (
    <main className="flex-1 flex flex-col items-center bg-background text-text">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", url: BUSINESS.url },
          { name: "Services", url: `${BUSINESS.url}/services` },
        ])}
      />
      <section className="w-full max-w-4xl px-6 pt-16 pb-20">
        <FadeIn direction="up">
          <div className="inline-block mb-4 px-4 py-1.5 rounded-full border border-red-primary/30 bg-red-light text-red-primary text-xs tracking-widest uppercase font-display font-semibold">
            Services
          </div>
          <h1 className="text-5xl md:text-6xl font-display font-bold mb-4 leading-tight">
            What we{" "}
            <span className="text-red-primary">fix in your driveway</span>
          </h1>
          <p className="text-xl text-text-secondary font-light mb-12 max-w-2xl leading-relaxed">
            Full mobile mechanic stack — same tools, same parts quality as a
            shop, in your driveway. No tow, no waiting room.
          </p>
        </FadeIn>

        <FadeIn direction="up" delay={0.1}>
          <div className="grid sm:grid-cols-2 gap-4">
            {SERVICES.map((s) => (
              <Link
                key={s.slug}
                href={`/services/${s.slug}`}
                className="group p-6 rounded-xl border border-border bg-surface hover:border-red-primary/40 transition-colors"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Wrench className="w-4 h-4 text-red-primary" />
                  <span className="font-display font-semibold text-lg group-hover:text-red-primary transition-colors">
                    {s.name}
                  </span>
                </div>
                <p className="text-sm text-text-secondary mb-4 line-clamp-3">
                  {s.intro}
                </p>
                <div className="flex items-center justify-between text-xs text-text-secondary">
                  <span>{s.typicalDuration}</span>
                  <span>{s.estimatedRange}</span>
                </div>
              </Link>
            ))}
          </div>
        </FadeIn>
      </section>
    </main>
  );
}
