"use client";

import { LayoutDashboard, LogIn, LogOut, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { ShopSwitcher } from "@/components/admin/ShopSwitcher";
import MobileNav from "./MobileNav";
import ThemeToggle from "./ThemeToggle";

const marketingLinks = [
  { href: "/", label: "Home" },
  { href: "/contact", label: "Contact" },
];
const customerChatLink = { href: "/chat", label: "Chat" };
const adminChatLink = { href: "/admin/chat", label: "Chat" };

const portalLink = { href: "/portal", label: "My Portal" };
const adminLink = { href: "/admin", label: "Admin", icon: LayoutDashboard };
const mechanicLink = { href: "/mechanic", label: "Mechanic", icon: Wrench };

export default function Navbar() {
  const pathname = usePathname();
  const { user, supabase, isLoading, isAdmin, isMechanic, isOwner } = useAuth();
  const isUserLoggedIn = !!user;
  const isHome = pathname === "/";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!isHome) return;
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHome]);

  const isTransparent = isHome && !scrolled;

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        isTransparent
          ? "bg-transparent border-b border-transparent"
          : "bg-background border-b border-border"
      }`}
    >
      <nav className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link
          href="/"
          className={`text-xl font-display font-bold tracking-tight transition-colors ${
            isTransparent ? "text-white" : "text-text"
          }`}
        >
          HMLS<span className="text-red-primary">.</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-8">
          {marketingLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className={`text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                pathname === href
                  ? "text-red-400"
                  : isTransparent
                    ? "text-white/70 hover:text-white"
                    : "text-text-secondary hover:text-text"
              }`}
            >
              {label}
            </Link>
          ))}
          {(() => {
            const link = isAdmin ? adminChatLink : customerChatLink;
            return (
              <Link
                href={link.href}
                prefetch={false}
                className={`text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                  pathname === link.href
                    ? "text-red-400"
                    : isTransparent
                      ? "text-white/70 hover:text-white"
                      : "text-text-secondary hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            );
          })()}
          {isUserLoggedIn && (
            <>
              <Link
                href={portalLink.href}
                prefetch={false}
                className={`text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                  pathname.startsWith(portalLink.href)
                    ? "text-red-400"
                    : isTransparent
                      ? "text-white/70 hover:text-white"
                      : "text-text-secondary hover:text-text"
                }`}
              >
                {isAdmin ? "View as Customer" : portalLink.label}
              </Link>
              {isAdmin && (
                <Link
                  href={adminLink.href}
                  prefetch={false}
                  className={`text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                    pathname.startsWith(adminLink.href)
                      ? "text-red-400"
                      : isTransparent
                        ? "text-white/70 hover:text-white"
                        : "text-text-secondary hover:text-text"
                  }`}
                >
                  {adminLink.label}
                </Link>
              )}
              {/* Admins with a linked provider row can also enter the
                  mechanic panel; non-linked admins hit a 403 from the
                  layout. */}
              {(isMechanic || isAdmin) && (
                <Link
                  href={mechanicLink.href}
                  prefetch={false}
                  className={`text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                    pathname.startsWith(mechanicLink.href)
                      ? "text-red-400"
                      : isTransparent
                        ? "text-white/70 hover:text-white"
                        : "text-text-secondary hover:text-text"
                  }`}
                >
                  {mechanicLink.label}
                </Link>
              )}
            </>
          )}
          {isOwner && <ShopSwitcher />}
          <ThemeToggle />
          {!isLoading &&
            (isUserLoggedIn ? (
              <button
                type="button"
                onClick={() => supabase.auth.signOut()}
                className={`flex items-center gap-2 text-sm transition-colors rounded focus-visible:ring-2 focus-visible:ring-red-primary ${
                  isTransparent
                    ? "text-white/70 hover:text-white"
                    : "text-text-secondary hover:text-text"
                }`}
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            ) : (
              <Link
                href="/login"
                prefetch={false}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  isTransparent
                    ? "border-white/30 text-white hover:border-white/60"
                    : "border-border text-text hover:border-red-500/50 hover:text-red-400"
                }`}
              >
                <LogIn className="w-4 h-4" />
                Sign In
              </Link>
            ))}
          {!isAdmin && (
            <Link
              href="/chat"
              prefetch={false}
              className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
            >
              Get a Quote
            </Link>
          )}
        </div>

        {/* Mobile nav */}
        <MobileNav isTransparent={isTransparent} />
      </nav>
    </header>
  );
}
