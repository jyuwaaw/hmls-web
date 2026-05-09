"use client";

import { Sparkles, X, Zap } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";

interface UpgradeModalProps {
  message: string;
  onClose: () => void;
}

// Mirror the server-side flat $1 = 100cr rate. Source of truth lives in
// apps/agent/src/fixo/lib/credits.ts (TOPUP_CENTS_PER_CREDIT).
const CREDITS_PER_DOLLAR = 100;
const SUGGESTED_USD = [5, 20, 50] as const;
const MIN_USD = 1;
const MAX_USD = 200;

export function UpgradeModal({ message, onClose }: UpgradeModalProps) {
  const { session } = useAuth();
  const [busy, setBusy] = useState<"plus" | "topup" | "redeem" | null>(null);
  const [customUsd, setCustomUsd] = useState<string>("");
  const [promoCode, setPromoCode] = useState<string>("");
  const [redeemMessage, setRedeemMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const handleUpgrade = async () => {
    if (!session || busy) return;
    setBusy("plus");
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
        return;
      }
    } catch (err) {
      console.error("Checkout error:", err);
    }
    setBusy(null);
  };

  const handleTopup = async (dollars: number) => {
    if (!session || busy) return;
    if (!Number.isInteger(dollars) || dollars < MIN_USD || dollars > MAX_USD) {
      return;
    }
    setBusy("topup");
    try {
      const res = await fetch(`${AGENT_URL}/billing/topup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          dollars,
          successUrl: `${window.location.origin}/chat?topped_up=true`,
          cancelUrl: `${window.location.origin}/chat`,
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
    } catch (err) {
      console.error("Top-up error:", err);
    }
    setBusy(null);
  };

  const customDollars = Number.parseInt(customUsd, 10);
  const customValid =
    Number.isInteger(customDollars) &&
    customDollars >= MIN_USD &&
    customDollars <= MAX_USD;

  const handleRedeem = async () => {
    if (!session || busy) return;
    const code = promoCode.trim();
    if (!code) return;
    setBusy("redeem");
    setRedeemMessage(null);
    try {
      const res = await fetch(`${AGENT_URL}/billing/redeem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (res.ok && data.credits) {
        setRedeemMessage({
          kind: "success",
          text: `+${data.credits.toLocaleString()} credits added to your account`,
        });
        setPromoCode("");
      } else {
        setRedeemMessage({
          kind: "error",
          text: data.message ?? "Code couldn't be redeemed",
        });
      }
    } catch {
      setRedeemMessage({ kind: "error", text: "Network error — try again" });
    }
    setBusy(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
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
          Out of credits
        </h2>
        <p className="mb-5 text-[13px] leading-relaxed text-muted-foreground">
          {message}
        </p>

        {/* Plus subscription — auto-renew at the same rate */}
        <button
          type="button"
          onClick={handleUpgrade}
          disabled={busy !== null}
          className="mb-4 w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {busy === "plus" ? (
            "Redirecting…"
          ) : (
            <>
              Upgrade to Plus — <span className="tabular-nums">$19.90/mo</span>
              <span className="ml-1 text-primary-foreground/80">
                · 2,000 credits/mo
              </span>
            </>
          )}
        </button>

        <div className="relative my-4 flex items-center">
          <div className="flex-1 border-t border-border" />
          <span className="px-3 text-[11px] uppercase tracking-wider text-muted-foreground">
            or top up — $1 = 100 credits
          </span>
          <div className="flex-1 border-t border-border" />
        </div>

        {/* Quick-pick dollar amounts */}
        <div className="grid grid-cols-3 gap-2">
          {SUGGESTED_USD.map((usd) => (
            <button
              key={usd}
              type="button"
              onClick={() => handleTopup(usd)}
              disabled={busy !== null}
              className="flex flex-col items-center justify-center rounded-md border border-border bg-card px-2 py-2.5 transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span className="font-mono text-base font-medium tabular-nums">
                ${usd}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                <Zap className="h-3 w-3" />
                {(usd * CREDITS_PER_DOLLAR).toLocaleString()}
              </span>
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="mt-2.5 flex items-stretch gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">
              $
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_USD}
              max={MAX_USD}
              step={1}
              value={customUsd}
              onChange={(e) => setCustomUsd(e.target.value)}
              placeholder="Custom"
              disabled={busy !== null}
              className="h-full w-full rounded-md border border-border bg-card pl-6 pr-2 font-mono text-sm tabular-nums focus:border-primary focus:outline-none disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => customValid && handleTopup(customDollars)}
            disabled={busy !== null || !customValid}
            className="rounded-md border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {customValid
              ? `${(customDollars * CREDITS_PER_DOLLAR).toLocaleString()} credits`
              : "Buy"}
          </button>
        </div>

        {/* Promo code input */}
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Have a code?
          </p>
          <div className="flex items-stretch gap-2">
            <input
              type="text"
              value={promoCode}
              onChange={(e) => {
                setPromoCode(e.target.value.toUpperCase());
                setRedeemMessage(null);
              }}
              placeholder="WELCOME50"
              maxLength={64}
              disabled={busy !== null}
              className="h-full flex-1 rounded-md border border-border bg-card px-3 py-2 font-mono text-sm uppercase tracking-wider focus:border-primary focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleRedeem}
              disabled={busy !== null || promoCode.trim().length === 0}
              className="rounded-md border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy === "redeem" ? "Redeeming…" : "Redeem"}
            </button>
          </div>
          {redeemMessage && (
            <p
              className={`mt-2 text-[11px] ${
                redeemMessage.kind === "success"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {redeemMessage.text}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className="mt-4 w-full rounded-md py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
