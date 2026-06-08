import { Clock, MapPin, Phone, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { FadeIn } from "@/components/ui/Animations";
import { BUSINESS, REGIONS } from "@/lib/business";
import { breadcrumbSchema, cityServiceSchema } from "@/lib/schema";
import { CITIES, findCity } from "@/lib/seo-content";

interface Props {
  params: Promise<{ city: string }>;
}

export function generateStaticParams() {
  return CITIES.map((c) => ({ city: c.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { city: slug } = await params;
  const city = findCity(slug);
  if (!city) return { title: "Not Found" };
  const title = `Mobile Mechanic in ${city.name}, CA`;
  const description = `On-demand mobile mechanic service in ${city.name}, California. Oil changes, brake repair, batteries, diagnostics, and pre-purchase inspections — we come to your driveway. Call ${BUSINESS.phoneDisplay}.`;
  return {
    title,
    description,
    alternates: { canonical: `${BUSINESS.url}/areas/${city.slug}` },
    openGraph: { title, description, type: "website" },
  };
}

export default async function CityPage({ params }: Props) {
  const { city: slug } = await params;
  const city = findCity(slug);
  if (!city) notFound();

  const region = REGIONS[city.region];
  const nearbyCities = CITIES.filter(
    (c) => c.slug !== city.slug && c.region === city.region,
  )
    .sort(
      (a, b) =>
        Math.abs(a.driveMinutes - city.driveMinutes) -
        Math.abs(b.driveMinutes - city.driveMinutes),
    )
    .slice(0, 4);

  return (
    <main className="flex-1 flex flex-col items-center bg-background text-text">
      <JsonLd data={cityServiceSchema(city)} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", url: BUSINESS.url },
          { name: "Service Areas", url: `${BUSINESS.url}/areas` },
          { name: city.name, url: `${BUSINESS.url}/areas/${city.slug}` },
        ])}
      />

      <section className="w-full max-w-4xl px-6 pt-16 pb-12">
        <FadeIn direction="up">
          <div className="inline-block mb-4 px-4 py-1.5 rounded-full border border-red-primary/30 bg-red-light text-red-primary text-xs tracking-widest uppercase font-display font-semibold">
            Service Area
          </div>
          <h1 className="text-5xl md:text-6xl font-display font-bold mb-4 leading-tight">
            Mobile Mechanic in{" "}
            <span className="text-red-primary">{city.name}</span>, CA
          </h1>
          <p className="text-xl text-text-secondary font-light mb-8 max-w-2xl leading-relaxed">
            {city.intro}
          </p>

          <div className="flex flex-wrap gap-6 mb-10 text-sm">
            <div className="flex items-center gap-2 text-text-secondary">
              <Clock className="w-4 h-4 text-red-primary" />
              <span>
                {city.driveMinutes === 0
                  ? "Same-day service (we’re local)"
                  : `~${city.driveMinutes} min from ${region.baseCity} base`}
              </span>
            </div>
            {region.rating && (
              <div className="flex items-center gap-2 text-text-secondary">
                <Star className="w-4 h-4 text-red-primary fill-current" />
                <span>
                  {region.rating.value.toFixed(1)} on Google (
                  {region.rating.count} reviews)
                </span>
              </div>
            )}
            <a
              href={`tel:${BUSINESS.phone}`}
              className="flex items-center gap-2 text-red-primary hover:underline"
            >
              <Phone className="w-4 h-4" />
              <span>{BUSINESS.phoneDisplay}</span>
            </a>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 mb-12">
            <Link
              href="/chat"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl bg-red-primary text-white font-semibold hover:bg-red-primary/90 transition-colors"
            >
              Get an Estimate Now
            </Link>
            <a
              href={`tel:${BUSINESS.phone}`}
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl border border-border bg-surface text-text font-semibold hover:bg-surface-alt transition-colors"
            >
              Call {BUSINESS.phoneDisplay}
            </a>
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={0.1}>
          <div className="p-6 rounded-2xl border border-border bg-surface mb-12">
            <p className="text-sm text-text">{city.callout}</p>
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={0.15}>
          <h2 className="text-2xl font-display font-bold mb-4">
            Neighborhoods we cover
          </h2>
          <div className="flex flex-wrap gap-2 mb-12">
            {city.neighborhoods.map((n) => (
              <div
                key={n}
                className="px-4 py-2 rounded-full bg-surface border border-border text-sm flex items-center gap-2"
              >
                <MapPin className="w-3 h-3 text-red-primary" />
                {n}
              </div>
            ))}
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={0.2}>
          <h2 className="text-2xl font-display font-bold mb-4">
            Services available in {city.name}
          </h2>
          <div className="grid sm:grid-cols-2 gap-3 mb-12">
            {BUSINESS.serviceTypes
              .filter((s) => s !== "Mobile Mechanic")
              .map((s) => (
                <Link
                  key={s}
                  href={`/services/${s.toLowerCase().replace(/\s+/g, "-")}`}
                  className="p-4 rounded-xl border border-border bg-surface hover:border-red-primary/40 transition-colors"
                >
                  <span className="font-medium">{s}</span>
                </Link>
              ))}
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={0.25}>
          <h2 className="text-2xl font-display font-bold mb-4">
            Nearby service areas
          </h2>
          <div className="grid sm:grid-cols-2 gap-3 mb-12">
            {nearbyCities.map((c) => (
              <Link
                key={c.slug}
                href={`/areas/${c.slug}`}
                className="p-4 rounded-xl border border-border bg-surface hover:border-red-primary/40 transition-colors flex items-center justify-between"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-text-secondary">
                  ~{c.driveMinutes} min from {region.baseCity}
                </span>
              </Link>
            ))}
          </div>
        </FadeIn>
      </section>
    </main>
  );
}
