"use client";

import { Car, LogOut, MessageSquare, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { ChatList } from "@/components/chat/ChatList";
import { NewChatButton } from "@/components/chat/NewChatButton";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/vehicles", label: "Vehicles", icon: Car },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Desktop sidebar (≥ lg). Mobile keeps BottomNav — see AppLayout.
 *
 * Layout: fixed left column, 240px wide, full height. Logo + new-chat button
 * top, primary nav, scrollable ChatList grouped by vehicle, account row bottom.
 */
export function Sidebar() {
  const pathname = usePathname();
  const { user, supabase } = useAuth();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <aside className="fixed left-0 top-0 z-30 hidden h-dvh w-60 flex-col border-r border-border bg-background/60 backdrop-blur-xl lg:flex">
      <div className="flex h-14 items-center justify-between px-5">
        <Link
          href="/chat"
          className="text-[15px] font-semibold tracking-tight text-accent"
        >
          Fixo<span className="text-accent-hover">.</span>
        </Link>
        <NewChatButton />
      </div>

      <nav className="px-3 pt-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              <Icon
                className="h-3.5 w-3.5"
                strokeWidth={isActive ? 2.25 : 1.75}
              />
              {label}
              {isActive && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 -translate-x-3 rounded-full bg-accent"
                />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-2 flex-1 overflow-y-auto border-t border-border">
        <ChatList />
      </div>

      {/* Account row: subtle, hairline-bordered, sign-out icon-only on hover */}
      <div className="border-t border-border p-3">
        <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[11px] font-semibold uppercase tabular-nums text-muted-foreground">
            {user?.email?.[0] ?? "?"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-foreground">
              {user?.email ?? "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
