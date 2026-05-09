import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { AnimateInView } from "@/components/ui/animate-in-view";
import { Button } from "@/components/ui/button";

export function CTASection() {
  return (
    <section className="py-24" aria-labelledby="cta-heading">
      <div className="max-w-3xl mx-auto px-6 text-center">
        <AnimateInView>
          <p className="mb-3 text-sm font-mono tracking-wide text-primary">
            START FREE
          </p>
          <h2
            id="cta-heading"
            className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.05] mb-4"
          >
            Diagnose your first car
            <br />
            problem in 30 seconds.
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto mb-8">
            No credit card. No mechanic appointment. Just snap a photo, paste an
            OBD-II code, or describe what&apos;s wrong — and find out before
            anyone tries to charge you to find out.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/login">
              <Button size="lg" className="h-12 px-7 text-[15px]">
                Try Free — Diagnose Now
                <ArrowRight className="size-4" />
              </Button>
            </Link>
            <Link href="/pricing">
              <Button
                variant="outline"
                size="lg"
                className="h-12 px-7 text-[15px]"
              >
                See Pricing
              </Button>
            </Link>
          </div>
          <p className="mt-5 text-xs font-mono uppercase tracking-wider text-muted-foreground/70">
            Free to start · No card · Cancel in 2 clicks
          </p>
        </AnimateInView>
      </div>
    </section>
  );
}
