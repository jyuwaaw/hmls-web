"use client";

import { Car, MessageSquare, MessagesSquare, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChatList } from "@/components/chat/ChatList";
import { NewChatButton } from "@/components/chat/NewChatButton";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/vehicles", label: "Vehicles", icon: Car },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const [chatsOpen, setChatsOpen] = useState(false);

  // Auto-close the sheet when the route changes (e.g. user taps a session)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    setChatsOpen(false);
  }, [pathname]);

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-lg items-center justify-around">
          <Link href="/chat" className={navItemClass(pathname === "/chat")}>
            <MessageSquare
              className="h-[18px] w-[18px]"
              strokeWidth={pathname === "/chat" ? 2.25 : 1.75}
            />
            <span>Chat</span>
            {pathname === "/chat" && <ActiveIndicator />}
          </Link>

          <button
            type="button"
            onClick={() => setChatsOpen(true)}
            aria-label="Open chats list"
            className={navItemClass(false)}
          >
            <MessagesSquare className="h-[18px] w-[18px]" strokeWidth={1.75} />
            <span>Chats</span>
          </button>

          {NAV_ITEMS.filter((i) => i.href !== "/chat").map(
            ({ href, label, icon: Icon }) => {
              const isActive = pathname === href;
              return (
                <Link key={href} href={href} className={navItemClass(isActive)}>
                  <Icon
                    className="h-[18px] w-[18px]"
                    strokeWidth={isActive ? 2.25 : 1.75}
                  />
                  <span>{label}</span>
                  {isActive && <ActiveIndicator />}
                </Link>
              );
            },
          )}
        </div>
      </nav>

      {chatsOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background lg:hidden">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-3">
              <span className="text-[15px] font-semibold tracking-tight">
                Chats
              </span>
              <NewChatButton />
            </div>
            <button
              type="button"
              onClick={() => setChatsOpen(false)}
              aria-label="Close chats list"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <ChatList />
          </div>
        </div>
      )}
    </>
  );
}

function navItemClass(isActive: boolean): string {
  return [
    "relative flex flex-col items-center gap-1 px-4 py-2.5 text-[11px] font-medium tracking-tight transition-colors",
    isActive
      ? "text-foreground"
      : "text-muted-foreground hover:text-foreground",
  ].join(" ");
}

function ActiveIndicator() {
  return (
    <span
      aria-hidden
      className="absolute -top-px left-1/2 h-[2px] w-8 -translate-x-1/2 rounded-full bg-accent"
    />
  );
}
