"use client";

import { Wrench } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NavBar() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border/40 bg-background">
      <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
        <Link href="/" className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
            <Wrench className="size-3.5 text-primary-foreground" />
          </div>
          <span className="text-base font-bold tracking-tight">
            Fixo<span className="text-primary">.</span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <Link href="/obd" className="hidden sm:inline-block">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              OBD Codes
            </Button>
          </Link>
          <Link href="/pricing">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              Pricing
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              Sign In
            </Button>
          </Link>
          <Link href="/login">
            <Button size="sm">Get Started</Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}
