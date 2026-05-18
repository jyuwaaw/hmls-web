"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { SidebarContent } from "@/components/SidebarContent";

interface DrawerCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const Ctx = createContext<DrawerCtx | null>(null);

function useDrawer(): DrawerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useDrawer must be used inside <MobileDrawerProvider>");
  return ctx;
}

/**
 * Mobile-only slide-in drawer that mirrors the desktop sidebar.
 *
 * - <MobileDrawerProvider> owns the open state (wrap the app layout).
 * - <MobileDrawer /> renders backdrop + sliding panel.
 * - <MobileDrawerTrigger /> is the ☰ button — drop into any page header.
 */
export function MobileDrawerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change so tapping a chat session in the drawer dismisses it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC closes the drawer (paired with the keyboard-focusable backdrop).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

export function MobileDrawer() {
  const { open, setOpen } = useDrawer();
  const close = useCallback(() => setOpen(false), [setOpen]);

  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={open ? 0 : -1}
        onClick={close}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`absolute left-0 top-0 flex h-dvh w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close menu"
          className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        <SidebarContent onNavigate={close} />
      </aside>
    </div>
  );
}

export function MobileDrawerTrigger({ className }: { className?: string }) {
  const { setOpen } = useDrawer();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open menu"
      className={
        className ??
        "-ml-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      }
    >
      <Menu className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}
