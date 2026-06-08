/**
 * SSOT for HMLS Mobile Mechanic NAP, hours, geo, and GMB identity.
 * Imported by root metadata, JSON-LD schemas, footer, contact page,
 * and email-side BUSINESS_ADDRESS via apps/agent.
 *
 * Move/rebrand = edit this file + redeploy. NAP must stay character-for-
 * character identical to the Google Business Profile.
 */

export const BUSINESS = {
  name: "HMLS Mobile Mechanic",
  legalName: "HMLS Mobile Mechanic",
  description:
    "Expert mobile mechanic service in Orange County. We come to you for oil changes, brake repair, diagnostics & more.",
  shortDescription:
    "Mobile mechanic service that comes to you in Orange County, CA.",

  url: "https://hmls.autos",

  email: "business@hmls.autos",
  phone: "+19492137073",
  phoneDisplay: "(949) 213-7073",

  address: {
    street: "283 Berkeley Ave",
    city: "Irvine",
    region: "CA",
    postalCode: "92612",
    country: "US",
  },

  geo: {
    latitude: 33.6484505,
    longitude: -117.8365716,
  },

  // Per-day hours in 24h. Cross-midnight closes (e.g. closes 03:00) are
  // schema.org-valid and Google interprets them as "the next morning".
  hours: [
    { day: "Sunday", opens: "09:00", closes: "01:00" },
    { day: "Monday", opens: "09:00", closes: "03:00" },
    { day: "Tuesday", opens: "09:00", closes: "03:00" },
    { day: "Wednesday", opens: "09:00", closes: "03:00" },
    { day: "Thursday", opens: "09:00", closes: "03:00" },
    { day: "Friday", opens: "09:00", closes: "03:00" },
    { day: "Saturday", opens: "09:00", closes: "01:00" },
  ],

  priceRange: "$$",

  serviceAreaCities: [
    "Irvine",
    "Newport Beach",
    "Costa Mesa",
    "Santa Ana",
    "Tustin",
    "Anaheim",
    "Orange",
    "Huntington Beach",
    "Fountain Valley",
    "Lake Forest",
    "Mission Viejo",
    "Aliso Viejo",
    "Laguna Hills",
    "Laguna Niguel",
  ],

  serviceTypes: [
    "Mobile Mechanic",
    "Oil Change",
    "Brake Repair",
    "Battery Replacement",
    "Diagnostics",
    "Pre-Purchase Inspection",
  ],

  // Google Business Profile identity
  gmb: {
    cid: "8440056806660845537",
    shareUrl: "https://maps.app.goo.gl/RXa8MovcqEfW5BUo6",
    mapsUrl: "https://www.google.com/maps?cid=8440056806660845537",
    // Embed iframe URL (place_id-equivalent, derived from the FID)
    embedUrl:
      "https://maps.google.com/maps?q=HMLS+Mobile+Mechanic+283+Berkeley+Ave+Irvine+CA&output=embed",
  },

  // Aggregate review snapshot (kept here so JSON-LD can advertise it;
  // bump these when you cross a milestone — Google doesn't crawl GMB on
  // your behalf for AggregateRating in JSON-LD).
  rating: {
    value: 5.0,
    count: 8,
  },
} as const;

export type Business = typeof BUSINESS;

/**
 * Full single-line postal address — used for CAN-SPAM email footer
 * (BUSINESS_ADDRESS env), Schema PostalAddress.streetAddress fallback,
 * and any place a single string is needed.
 */
export const BUSINESS_ADDRESS_ONELINE = `${BUSINESS.address.street}, ${BUSINESS.address.city}, ${BUSINESS.address.region} ${BUSINESS.address.postalCode}`;

/**
 * Multi-metro support. `BUSINESS` above stays the OC/default identity (home
 * page, root metadata, CAN-SPAM email footer). `REGIONS` layers per-metro NAP
 * onto the programmatic SEO pages (`/areas/[city]`) so a San Jose page shows
 * SJ-relevant drive times + geo and does NOT borrow Orange County's review
 * count.
 *
 * Phone is shared across metros for now (one line). When SJ gets a local 408
 * number, give the `sj` entry its own `phone` / `phoneDisplay`.
 */
export type RegionId = "oc" | "sj";

export interface Region {
  id: RegionId;
  /** Metro display name, e.g. "Orange County". */
  label: string;
  /** Home-base city — rendered as "~N min from {baseCity} base". */
  baseCity: string;
  phone: string;
  phoneDisplay: string;
  address: {
    street?: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
  geo: { latitude: number; longitude: number };
  /**
   * Per-listing review snapshot. `null` until the metro has its own reviews —
   * SJ starts here so its pages never advertise OC's rating in JSON-LD.
   */
  rating: { value: number; count: number } | null;
  /** Google Business Profile share URL for this metro, once it has a listing. */
  gmbShareUrl?: string;
}

export const REGIONS: Record<RegionId, Region> = {
  oc: {
    id: "oc",
    label: "Orange County",
    baseCity: "Irvine",
    phone: BUSINESS.phone,
    phoneDisplay: BUSINESS.phoneDisplay,
    address: BUSINESS.address,
    geo: BUSINESS.geo,
    rating: BUSINESS.rating,
    gmbShareUrl: BUSINESS.gmb.shareUrl,
  },
  sj: {
    id: "sj",
    label: "San Jose",
    baseCity: "San Jose",
    // Shared line for now — swap in a local 408 number when SJ gets one.
    phone: BUSINESS.phone,
    phoneDisplay: BUSINESS.phoneDisplay,
    // Service-area business: no public street address yet (set during GBP setup).
    address: {
      city: "San Jose",
      region: "CA",
      postalCode: "95113",
      country: "US",
    },
    geo: { latitude: 37.3361663, longitude: -121.890591 },
    // No reviews yet — SJ pages omit aggregateRating until real reviews land.
    rating: null,
  },
};
