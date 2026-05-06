"use client";

import { Sparkles, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";

interface UpgradeModalProps {
  message: string;
  onClose: () => void;
}

export function UpgradeModal({ message, onClose }: UpgradeModalProps) {
  const { session } = useAuth();

  const handleUpgrade = async () => {
    if (!session) return;

    try {
      const res = await fetch(`${AGENT_URL}/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/chat?upgraded=true`,
          cancelUrl: `${window.location.origin}/chat`,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-start justify-between">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted">
            <Sparkles className="h-4 w-4 text-foreground" strokeWidth={1.75} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 className="mb-1.5 text-base font-semibold tracking-tight">
          Upgrade to Plus
        </h2>
        <p className="mb-5 text-[13px] leading-relaxed text-muted-foreground">
          {message}
        </p>

        <ul className="mb-5 space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground">+</span>
            Unlimited diagnoses
          </li>
          <li className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground">+</span>
            Photo, audio, video &amp; OBD
          </li>
          <li className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground">+</span>
            PDF diagnostic reports
          </li>
        </ul>

        <button
          type="button"
          onClick={handleUpgrade}
          className="mb-1.5 w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Upgrade — <span className="tabular-nums">$19.99/mo</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
