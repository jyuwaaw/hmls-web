import { Database, ShieldCheck, Zap } from "lucide-react";
import { AnimateInView } from "@/components/ui/animate-in-view";

/**
 * Pre-testimonial trust strip. Until we have real reviews to surface, lean
 * on factual claims that mechanic-curious users actually care about: who
 * powers the diagnosis, what data goes where, and what's covered. Replace
 * (or supplement) with a Review schema block once user count is meaningful.
 */
const TRUST_POINTS = [
  {
    icon: Zap,
    label: "Frontier multimodal AI",
    body: "Vision, audio, and text models cross-referenced against a curated DTC + symptom database, not a generic chatbot.",
  },
  {
    icon: ShieldCheck,
    label: "Privacy-first",
    body: "Photos and audio you upload generate your private diagnosis only. No data sale, no public model training.",
  },
  {
    icon: Database,
    label: "Universal coverage",
    body: "Works on any 1996+ US-market vehicle via OBD-II. Symptom-based diagnosis for everything older or newer.",
  },
] as const;

const VEHICLE_MAKES = [
  "Toyota",
  "Honda",
  "Ford",
  "Chevrolet",
  "Tesla",
  "BMW",
  "Mercedes-Benz",
  "Subaru",
  "Mazda",
  "Nissan",
  "Hyundai",
  "Kia",
  "Volkswagen",
  "Audi",
  "Jeep",
  "Ram",
  "GMC",
  "Lexus",
] as const;

export function TrustSection() {
  return (
    <section
      className="py-16 border-t border-border/40"
      aria-labelledby="trust-heading"
    >
      <div className="max-w-5xl mx-auto px-6">
        <AnimateInView className="mb-10 text-center max-w-2xl mx-auto">
          <p className="mb-2 text-sm font-mono tracking-wide text-primary">
            WHY TRUST IT
          </p>
          <h2
            id="trust-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight"
          >
            Diagnoses you can actually take to a mechanic.
          </h2>
        </AnimateInView>

        {/* Three-column factual proof points */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
          {TRUST_POINTS.map((p, i) => (
            <AnimateInView
              key={p.label}
              className="rounded-xl border border-border/60 bg-card p-5"
              delay={i * 80}
            >
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-7 rounded-md bg-primary/10 flex items-center justify-center">
                  <p.icon className="size-3.5 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">{p.label}</h3>
              </div>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {p.body}
              </p>
            </AnimateInView>
          ))}
        </div>

        {/* Vehicle make coverage strip — flat names beat fake logos for
         * trademark safety and look honest in a launch context */}
        <AnimateInView className="rounded-xl border border-border/60 bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-2.5">
            <span className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground">
              MAKES COVERED
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {VEHICLE_MAKES.length}+ MAJOR BRANDS
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 px-5 py-4 text-[13px] text-muted-foreground">
            {VEHICLE_MAKES.map((m) => (
              <span
                key={m}
                className="font-mono tabular-nums hover:text-foreground transition-colors"
              >
                {m}
              </span>
            ))}
            <span className="font-mono italic text-muted-foreground/60">
              + everything else with OBD-II
            </span>
          </div>
        </AnimateInView>
      </div>
    </section>
  );
}
