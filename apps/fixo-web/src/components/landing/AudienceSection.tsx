import { AlertCircle, Car, ShieldCheck, Wallet } from "lucide-react";
import { AnimateInView } from "@/components/ui/animate-in-view";

/**
 * Built around four high-intent moments where a car owner searches for
 * help. Each card is a real "I have this problem" story tied to a Fixo
 * capability — better long-tail SEO and warmer conversion than a generic
 * features grid.
 */
const personas = [
  {
    icon: AlertCircle,
    title: "Check engine light just came on",
    body: "Plug your OBD-II code (or just describe the symptoms) and find out whether it's a $50 sensor or a $1,200 catalytic converter — before you panic.",
  },
  {
    icon: Wallet,
    title: "Mechanic quoted me $800 — is that fair?",
    body: "Run the same diagnosis Fixo runs for any shop. Get a parts and labor range you can compare against the quote. Walk back in informed.",
  },
  {
    icon: Car,
    title: "Thinking of buying a used car",
    body: "Snap photos of the engine bay, undercarriage, and dashboard. Fixo flags anything sketchy — fluid leaks, mismatched panels, warning codes — before you sign.",
  },
  {
    icon: ShieldCheck,
    title: "Weird noise that won't go away",
    body: "Record the click, knock, or whine. Fixo's audio analysis maps it to the most common causes by RPM, speed, or steering input.",
  },
] as const;

export function AudienceSection() {
  return (
    <section className="py-20" aria-labelledby="use-cases-heading">
      <div className="max-w-5xl mx-auto px-6">
        <AnimateInView className="mb-12 max-w-2xl" margin="-80px">
          <p className="mb-2 text-sm font-mono text-primary tracking-wide">
            USE CASES
          </p>
          <h2
            id="use-cases-heading"
            className="text-3xl sm:text-4xl font-bold tracking-tight"
          >
            Built for the moments you Google your car.
          </h2>
          <p className="mt-2 text-muted-foreground">
            The four scenarios most owners hit at least once a year. Fixo
            handles all of them in one place.
          </p>
        </AnimateInView>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {personas.map((p, i) => (
            <AnimateInView
              key={p.title}
              className="rounded-xl border border-border/60 bg-card p-6 hover:border-border transition-colors"
              delay={i * 70}
            >
              <div className="flex items-start gap-4">
                <div className="size-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <p.icon className="size-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold leading-snug mb-1.5">
                    {p.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {p.body}
                  </p>
                </div>
              </div>
            </AnimateInView>
          ))}
        </div>
      </div>
    </section>
  );
}
