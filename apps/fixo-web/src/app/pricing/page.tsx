"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";

function PricingCard({
  name,
  price,
  period,
  features,
  cta,
  href,
  highlighted,
  onClick,
}: {
  name: string;
  price: string;
  period?: string;
  features: string[];
  cta: string;
  href?: string;
  highlighted?: boolean;
  onClick?: () => void;
}) {
  const className = `rounded-2xl border p-6 flex flex-col ${
    highlighted
      ? "border-primary bg-primary/5 ring-1 ring-primary"
      : "border-border bg-surface"
  }`;

  const button = (
    <button
      type="button"
      onClick={onClick}
      className={`mt-auto w-full py-3 rounded-xl font-medium transition-colors ${
        highlighted
          ? "bg-primary text-white hover:bg-primary-hover"
          : "bg-surface-alt text-text hover:bg-surface-hover"
      }`}
    >
      {cta}
    </button>
  );

  return (
    <div className={className}>
      <h3 className="text-lg font-semibold mb-1">{name}</h3>
      <div className="mb-4">
        <span className="text-3xl font-bold">{price}</span>
        {period && (
          <span className="text-text-secondary text-sm">{period}</span>
        )}
      </div>
      <ul className="space-y-2 mb-6 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm">
            <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {href ? (
        <Link href={href} className="mt-auto">
          {button}
        </Link>
      ) : (
        button
      )}
    </div>
  );
}

export default function PricingPage() {
  const { session } = useAuth();

  const handleUpgrade = async () => {
    if (!session) {
      window.location.href = "/login";
      return;
    }

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
      }
    } catch (err) {
      console.error("Checkout error:", err);
    }
  };

  return (
    <div className="min-h-dvh bg-background p-6">
      <div className="max-w-2xl mx-auto pt-12">
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-400 fill-mode-both">
          <h1 className="text-3xl font-bold text-center mb-2">
            Simple Pricing
          </h1>
          <p className="text-text-secondary text-center mb-8">
            Try free, upgrade when you need more
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-400 delay-100 fill-mode-both">
            <PricingCard
              name="Free"
              price="$0"
              features={[
                "200 credits/month",
                "Photo, audio, video, OBD",
                "PDF diagnostic reports",
                "Unlimited vehicles",
              ]}
              cta="Get Started"
              href="/login"
            />
          </div>

          <div className="animate-in fade-in slide-in-from-bottom-4 duration-400 delay-200 fill-mode-both">
            <PricingCard
              name="Plus"
              price="$19.90"
              period="/month"
              features={[
                "2,000 credits/month",
                "10× the Free allowance",
                "Best per-credit price",
                "Top-up packs available anytime",
                "Full diagnosis history",
              ]}
              cta="Start Plus"
              onClick={handleUpgrade}
              highlighted
            />
          </div>
        </div>
      </div>
    </div>
  );
}
