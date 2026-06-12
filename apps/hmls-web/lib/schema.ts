import { BUSINESS, REGIONS, type Region } from "./business";
import { CITIES, type CityContent, type ServiceContent } from "./seo-content";

/**
 * JSON-LD builders. Each returns a plain object suitable for `<JsonLd>`.
 * Keep these pure (no I/O) so they can run at build time.
 */

const ORG_ID = `${BUSINESS.url}#business`;

function postalAddress(region: Region = REGIONS.oc) {
  return {
    "@type": "PostalAddress",
    ...(region.address.street ? { streetAddress: region.address.street } : {}),
    addressLocality: region.address.city,
    addressRegion: region.address.region,
    postalCode: region.address.postalCode,
    addressCountry: region.address.country,
  };
}

function geoCoordinates(region: Region = REGIONS.oc) {
  return {
    "@type": "GeoCoordinates",
    latitude: region.geo.latitude,
    longitude: region.geo.longitude,
  };
}

function openingHoursSpecification() {
  return BUSINESS.hours.map((h) => ({
    "@type": "OpeningHoursSpecification",
    dayOfWeek: `https://schema.org/${h.day}`,
    opens: h.opens,
    closes: h.closes,
  }));
}

function areaServedCities() {
  // All metros we serve (OC + SJ), so the home + service-page structured data
  // reflects the full footprint, not just Orange County.
  return CITIES.map((c) => ({
    "@type": "City",
    name: c.name,
    containedInPlace: { "@type": "State", name: "California" },
  }));
}

function offerCatalog() {
  return {
    "@type": "OfferCatalog",
    name: "Mobile Mechanic Services",
    itemListElement: BUSINESS.serviceTypes.map((service) => ({
      "@type": "Offer",
      itemOffered: { "@type": "Service", name: service },
    })),
  };
}

/** Rich AutoRepair LocalBusiness — used on the marketing home page. */
export function autoRepairSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "AutoRepair",
    "@id": ORG_ID,
    name: BUSINESS.name,
    legalName: BUSINESS.legalName,
    description: BUSINESS.description,
    url: BUSINESS.url,
    telephone: BUSINESS.phone,
    email: BUSINESS.email,
    image: `${BUSINESS.url}/opengraph-image`,
    logo: `${BUSINESS.url}/icon`,
    priceRange: BUSINESS.priceRange,
    address: postalAddress(),
    geo: geoCoordinates(),
    openingHoursSpecification: openingHoursSpecification(),
    areaServed: areaServedCities(),
    // One circle per metro base — a single Irvine-centered circle would
    // contradict the SJ entries in areaServed.
    serviceArea: Object.values(REGIONS).map((region) => ({
      "@type": "GeoCircle",
      geoMidpoint: geoCoordinates(region),
      geoRadius: 40000, // ~25 miles
    })),
    hasOfferCatalog: offerCatalog(),
    sameAs: [BUSINESS.gmb.shareUrl, BUSINESS.gmb.mapsUrl],
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: BUSINESS.rating.value,
      reviewCount: BUSINESS.rating.count,
      bestRating: 5,
      worstRating: 1,
    },
  };
}

/** Per-city LocalBusiness schema for /areas/[city] pages. */
export function cityServiceSchema(city: CityContent) {
  const region = REGIONS[city.region];
  const url = `${BUSINESS.url}/areas/${city.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "AutoRepair",
    "@id": `${url}#business`,
    name: `${BUSINESS.name} — ${city.name}`,
    url,
    telephone: region.phone,
    email: BUSINESS.email,
    description: `Mobile mechanic service for ${city.name}, CA — oil changes, brakes, batteries, diagnostics, and pre-purchase inspections in your driveway.`,
    parentOrganization: { "@id": ORG_ID },
    address: postalAddress(region),
    geo: geoCoordinates(region),
    priceRange: BUSINESS.priceRange,
    areaServed: {
      "@type": "City",
      name: city.name,
      containedInPlace: { "@type": "State", name: "California" },
    },
    hasOfferCatalog: offerCatalog(),
    // Only advertise a GMB link / rating the metro actually has. SJ has neither
    // yet, so its pages omit both rather than borrowing OC's.
    ...(region.gmbShareUrl ? { sameAs: [region.gmbShareUrl] } : {}),
    ...(region.rating
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: region.rating.value,
            reviewCount: region.rating.count,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
  };
}

/** Per-service Service schema for /services/[service] pages. */
export function serviceSchema(service: ServiceContent) {
  const url = `${BUSINESS.url}/services/${service.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${url}#service`,
    name: service.name,
    description: service.intro.replace(/&[a-z]+;/g, ""),
    url,
    provider: { "@id": ORG_ID },
    areaServed: areaServedCities(),
    serviceType: service.shortName,
    offers: {
      "@type": "Offer",
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "PriceSpecification",
        description: service.estimatedRange,
      },
    },
  };
}

/** BreadcrumbList for nested pages (city, service, etc.). */
export function breadcrumbSchema(trail: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((node, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: node.name,
      item: node.url,
    })),
  };
}

/** Site-wide WebSite schema with SearchAction — goes in root layout. */
export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BUSINESS.name,
    url: BUSINESS.url,
    publisher: { "@id": ORG_ID },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${BUSINESS.url}/?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}
