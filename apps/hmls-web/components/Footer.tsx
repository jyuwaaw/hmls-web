import Link from "next/link";
import { BUSINESS, BUSINESS_ADDRESS_ONELINE } from "@/lib/business";
import { CITIES, SERVICES } from "@/lib/seo-content";

export default function Footer() {
  return (
    <footer className="w-full bg-neutral-950 border-t border-white/10">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div className="col-span-2 md:col-span-1">
            <div className="text-xl font-display font-bold text-white">
              HMLS<span className="text-red-500">.</span>
            </div>
            <div className="text-sm text-white/40 mt-1">
              Mobile Mechanic &bull; Orange County &amp; San Jose, CA
            </div>
            <div className="text-xs text-white/30 mt-3">
              {BUSINESS_ADDRESS_ONELINE}
            </div>
            <a
              href={`tel:${BUSINESS.phone}`}
              className="block text-xs text-white/40 hover:text-white mt-2 transition-colors"
            >
              {BUSINESS.phoneDisplay}
            </a>
            <a
              href={BUSINESS.gmb.shareUrl}
              target="_blank"
              rel="noopener"
              className="inline-block text-xs text-red-400 hover:text-red-300 mt-3 transition-colors"
            >
              Leave a Google Review →
            </a>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-white/60 font-semibold mb-3">
              Services
            </div>
            <ul className="space-y-2">
              {SERVICES.map((s) => (
                <li key={s.slug}>
                  <Link
                    href={`/services/${s.slug}`}
                    className="text-sm text-white/40 hover:text-white transition-colors"
                  >
                    {s.shortName}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-white/60 font-semibold mb-3">
              Service Areas
            </div>
            <ul className="space-y-2">
              {CITIES.slice(0, 7).map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/areas/${c.slug}`}
                    className="text-sm text-white/40 hover:text-white transition-colors"
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/areas"
                  className="text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  All areas →
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-white/60 font-semibold mb-3">
              Company
            </div>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/contact"
                  className="text-sm text-white/40 hover:text-white transition-colors"
                >
                  Contact
                </Link>
              </li>
              <li>
                <Link
                  href="/services"
                  className="text-sm text-white/40 hover:text-white transition-colors"
                >
                  All services
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="text-sm text-white/40 hover:text-white transition-colors"
                >
                  Terms
                </Link>
              </li>
              <li>
                <Link
                  href="/privacy"
                  className="text-sm text-white/40 hover:text-white transition-colors"
                >
                  Privacy
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-white/5 text-sm text-white/30">
          <span suppressHydrationWarning>
            &copy; {new Date().getFullYear()} HMLS. All rights reserved.
          </span>
        </div>
      </div>
    </footer>
  );
}
