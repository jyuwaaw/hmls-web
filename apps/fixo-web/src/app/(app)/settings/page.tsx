"use client";

import {
  ChevronRight,
  ExternalLink,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { UpgradeModal } from "@/components/UpgradeModal";
import { AGENT_URL } from "@/lib/config";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

interface BalanceResponse {
  unlimited: boolean;
  monthly: number;
  topup: number;
  total: number | null;
  tier: "free" | "plus" | "pro";
}

interface LedgerEntry {
  id: number;
  delta: number;
  bucket: "monthly" | "topup";
  reason: string;
  inputType: string | null;
  sessionId: number | null;
  createdAt: string;
}

interface UsageStats {
  totalSpent: number;
  grantedThisPeriod: number;
  monthlyPeriodStart: string | null;
  nextFreeRefreshAt: string | null;
  byInputType: Record<string, number>;
  unlimited?: boolean;
}

const REASON_LABELS: Record<string, string> = {
  subscription_grant: "Subscription credit",
  free_monthly_grant: "Free monthly refresh",
  topup_purchase: "Top-up purchase",
  consumption: "Used",
  refund: "Refund",
  admin_adjustment: "Admin adjustment",
  legacy_migration: "Initial setup",
};

const INPUT_LABELS: Record<string, string> = {
  text: "chat",
  obd: "OBD lookup",
  photo: "photo",
  audio: "audio",
  video: "video",
  report: "report",
};

function formatLedgerLabel(entry: LedgerEntry): string {
  if (entry.reason === "consumption" && entry.inputType) {
    return INPUT_LABELS[entry.inputType] ?? entry.inputType;
  }
  return REASON_LABELS[entry.reason] ?? entry.reason;
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) {
    const hours = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60));
    if (hours === 0) return "just now";
    return `${hours}h ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRefreshDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "any moment now";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  return `on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export default function SettingsPage() {
  const { user, session, supabase } = useAuth();
  const { theme, setTheme } = useTheme();
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [history, setHistory] = useState<LedgerEntry[] | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [showTopup, setShowTopup] = useState(false);

  useEffect(() => {
    if (!session?.access_token) return;
    const auth = `Bearer ${session.access_token}`;
    let cancelled = false;
    Promise.all([
      fetch(`${AGENT_URL}/billing/balance`, {
        headers: { Authorization: auth },
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${AGENT_URL}/billing/history?limit=10`, {
        headers: { Authorization: auth },
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${AGENT_URL}/billing/usage`, { headers: { Authorization: auth } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([b, h, u]) => {
      if (cancelled) return;
      setBalance(b);
      setHistory(h?.entries ?? []);
      setUsage(u);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  const handleManageSubscription = async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch(`${AGENT_URL}/billing/portal`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        window.location.href = data.url;
      }
    } catch {
      // silently fail
    }
  };

  const planLabel =
    balance?.tier === "pro"
      ? "Pro"
      : balance?.tier === "plus"
        ? "Plus"
        : "Free";

  return (
    <div className="flex h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center border-b border-border bg-background px-4">
        <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 pb-24">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Account */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Account
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Email</p>
                <p className="mt-0.5 text-sm font-medium">
                  {user?.email ?? "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-500 dark:hover:bg-red-900/10"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </div>
          </section>

          {/* Credits */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Credits
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {balance?.unlimited ? (
                <div className="px-4 py-4">
                  <p className="text-xs text-muted-foreground">Balance</p>
                  <p className="mt-0.5 text-sm font-medium">Unlimited</p>
                </div>
              ) : (
                <div className="px-4 py-4">
                  <div className="flex items-baseline justify-between">
                    <p className="text-xs text-muted-foreground">Balance</p>
                    {balance && (
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {planLabel} plan
                      </p>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
                    {balance ? (balance.total ?? 0).toLocaleString() : "—"}
                  </p>
                  {balance && (
                    <div className="mt-2 flex gap-4 text-[11px] text-muted-foreground">
                      <span>
                        <span className="tabular-nums">
                          {balance.monthly.toLocaleString()}
                        </span>{" "}
                        monthly
                      </span>
                      <span>
                        <span className="tabular-nums">
                          {balance.topup.toLocaleString()}
                        </span>{" "}
                        top-up
                      </span>
                    </div>
                  )}
                </div>
              )}
              {!balance?.unlimited && (
                <button
                  type="button"
                  onClick={() => setShowTopup(true)}
                  className="flex w-full items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                    Buy more credits
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
              {/* Next refresh hint (Free tier only — Plus/Pro is Stripe-driven) */}
              {!balance?.unlimited &&
                usage?.nextFreeRefreshAt &&
                balance?.tier === "free" && (
                  <div className="px-4 py-2.5 text-[11px] text-muted-foreground">
                    Monthly credits refresh{" "}
                    {formatRefreshDate(usage.nextFreeRefreshAt)} — unused
                    monthly credits are reset.
                  </div>
                )}
            </div>
          </section>

          {/* Recent activity */}
          {!balance?.unlimited && history && history.length > 0 && (
            <section>
              <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Recent activity
              </h2>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {history.map((entry) => {
                  const isCharge = entry.delta < 0;
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {formatLedgerLabel(entry)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {formatRelativeDate(entry.createdAt)} ·{" "}
                          <span className="font-mono">{entry.bucket}</span>
                        </p>
                      </div>
                      <span
                        className={`font-mono text-sm tabular-nums ${
                          isCharge
                            ? "text-muted-foreground"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {isCharge ? "" : "+"}
                        {entry.delta.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Subscription */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Subscription
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-xs text-muted-foreground">Current plan</p>
                  <p className="mt-0.5 text-sm font-medium">{planLabel}</p>
                </div>
                {balance?.tier === "free" && (
                  <a
                    href="/pricing"
                    className="inline-flex items-center justify-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
                  >
                    Upgrade
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={handleManageSubscription}
                className="flex w-full items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-muted"
              >
                <span>Manage subscription</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          </section>

          {/* Theme */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Appearance
            </h2>
            <div className="flex gap-0.5 rounded-lg border border-border bg-card p-0.5">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    theme === value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/* About */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              About
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm">Version</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  0.1.0
                </span>
              </div>
              <a
                href="/privacy"
                className="flex items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-muted"
              >
                <span>Privacy policy</span>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
              <a
                href="/terms"
                className="flex items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-muted"
              >
                <span>Terms of service</span>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </div>
          </section>
        </div>
      </div>

      {showTopup && (
        <UpgradeModal
          message="Pick a credit pack or upgrade to Plus for monthly credits + a discount."
          onClose={() => setShowTopup(false)}
        />
      )}
    </div>
  );
}
