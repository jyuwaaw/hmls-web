"use client";

import {
  ChevronRight,
  ExternalLink,
  LogOut,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export default function SettingsPage() {
  const { user, session, supabase } = useAuth();
  const { theme, setTheme } = useTheme();

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

          {/* Subscription */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Subscription
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-xs text-muted-foreground">Current plan</p>
                  <p className="mt-0.5 text-sm font-medium">Free</p>
                </div>
                <a
                  href="/pricing"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
                >
                  Upgrade
                </a>
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
    </div>
  );
}
