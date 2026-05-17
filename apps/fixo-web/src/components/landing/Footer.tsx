import { Wrench } from "lucide-react";
import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border/40 py-8">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <div className="size-5 rounded bg-primary flex items-center justify-center">
            <Wrench className="size-3 text-primary-foreground" />
          </div>
          Fixo<span className="text-primary">.</span>
        </div>
        <div className="flex gap-6">
          <Link href="/obd" className="hover:text-foreground transition-colors">
            OBD Codes
          </Link>
          <Link
            href="/pricing"
            className="hover:text-foreground transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="hover:text-foreground transition-colors"
          >
            Sign In
          </Link>
        </div>
        <p>
          &copy; {new Date().getFullYear()} Fixo
          <span className="text-primary">.</span>
        </p>
      </div>
    </footer>
  );
}
