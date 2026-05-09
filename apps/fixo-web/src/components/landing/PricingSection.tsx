import { Check } from "lucide-react";
import Link from "next/link";
import { AnimateInView } from "@/components/ui/animate-in-view";
import { Button } from "@/components/ui/button";

export function PricingSection() {
  return (
    <section className="py-20 bg-muted/30 border-y border-border/40">
      <div className="max-w-3xl mx-auto px-6">
        <AnimateInView className="text-center mb-12">
          <p className="text-sm font-mono text-primary mb-2 tracking-wide">
            PRICING
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2">
            One shop visit or a year of Plus.
          </h2>
          <p className="text-muted-foreground">You pick.</p>
        </AnimateInView>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
          <AnimateInView className="rounded-xl border border-border/60 bg-card p-7">
            <h3 className="font-semibold mb-1">Free</h3>
            <div className="mb-5">
              <span className="text-4xl font-bold tabular-nums">$0</span>
            </div>
            <ul className="space-y-2 mb-7">
              {[
                "200 credits/mo · ~1 full diagnosis",
                "Photo, audio, video & OBD-II",
                "PDF reports",
                "Unlimited vehicles",
              ].map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <Check className="size-3.5 text-primary mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link href="/login">
              <Button variant="outline" className="w-full">
                Get Started
              </Button>
            </Link>
          </AnimateInView>

          <AnimateInView
            className="rounded-xl border-2 border-primary/30 bg-card p-7 relative"
            delay={80}
          >
            <span className="absolute -top-2.5 left-5 text-[11px] font-mono bg-primary text-primary-foreground px-2 py-0.5 rounded">
              RECOMMENDED
            </span>
            <h3 className="font-semibold mb-1">Plus</h3>
            <div className="mb-5">
              <span className="text-4xl font-bold tabular-nums">$19.90</span>
              <span className="text-sm text-muted-foreground">/mo</span>
            </div>
            <ul className="space-y-2 mb-7">
              {[
                "2,000 credits/mo · ~13 full diagnoses",
                "10× the Free monthly grant",
                "Top-up packs anytime ($1 = 100 cr)",
                "Full diagnosis history",
                "Cancel anytime",
              ].map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <Check className="size-3.5 text-primary mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link href="/pricing">
              <Button className="w-full">Start Plus — $19.90/mo</Button>
            </Link>
          </AnimateInView>
        </div>
      </div>
    </section>
  );
}
