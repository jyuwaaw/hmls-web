"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import RevealOnScroll from "@/components/ui/RevealOnScroll";
import { CITIES } from "@/lib/seo-content";

const ServiceMap = dynamic(() => import("@/components/ui/RealMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-surface animate-pulse rounded-xl" />
  ),
});

export default function ServiceArea() {
  const mapHostRef = useRef<HTMLDivElement>(null);
  const [shouldMountMap, setShouldMountMap] = useState(false);

  // Defer mounting Leaflet (≈150KB JS + 9 tile downloads + DOM init) until the
  // user is within 600px of the map. Otherwise the entire init chain runs in
  // a single frame the moment the section scrolls into view, producing a
  // visible hitch. The 600px lead time lets the browser amortize the work
  // across several idle frames before the user actually gets there.
  useEffect(() => {
    const el = mapHostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldMountMap(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldMountMap(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="w-full py-32 bg-background">
      <div className="max-w-7xl mx-auto px-6">
        <RevealOnScroll>
          <div className="text-center mb-16">
            <p className="text-sm uppercase tracking-[0.2em] text-red-400 font-display font-semibold mb-4">
              Service Area
            </p>
            <h2 className="text-4xl md:text-5xl font-display font-extrabold text-text tracking-tight">
              Serving Orange County &amp; San Jose
            </h2>
          </div>
        </RevealOnScroll>

        <RevealOnScroll>
          <div
            ref={mapHostRef}
            className="w-full h-[450px] rounded-2xl overflow-hidden border border-border mb-10"
          >
            {shouldMountMap ? (
              <Suspense
                fallback={
                  <div className="w-full h-full bg-surface animate-pulse" />
                }
              >
                <ServiceMap className="w-full h-full" />
              </Suspense>
            ) : (
              <div className="w-full h-full bg-surface" />
            )}
          </div>
        </RevealOnScroll>

        <RevealOnScroll>
          <div className="flex flex-wrap justify-center gap-3">
            {CITIES.map((city) => (
              <Link
                key={city.slug}
                href={`/areas/${city.slug}`}
                className="px-5 py-2.5 bg-surface border border-border rounded-full text-sm text-text-secondary font-display hover:border-red-500/30 hover:text-text transition-all duration-300"
              >
                {city.name}
              </Link>
            ))}
            <Link
              href="/areas"
              className="px-5 py-2.5 text-sm text-red-400 hover:text-red-300 font-display transition-colors"
            >
              View all areas →
            </Link>
          </div>
        </RevealOnScroll>
      </div>
    </section>
  );
}
