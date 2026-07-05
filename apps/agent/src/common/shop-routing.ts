export interface ShopGeo {
  id: string;
  latitude: string | null;
  longitude: string | null;
  serviceRadiusKm: number | null;
}
export interface Coords {
  lat: number;
  lng: number;
}

import zipCentroids from "./data/zip-centroids.json" with { type: "json" };

const ZIP_TABLE = zipCentroids as unknown as Record<string, [number, number]>;

/** Map a US ZIP (5-digit or ZIP+4) to its ZCTA centroid, or null on miss.
 *  Precision is centroid-level — enough to route to the nearest shop, not to
 *  dispatch a mechanic. */
export function zipToCoords(zip: string): Coords | null {
  const m = /^(\d{5})/.exec(zip.trim());
  if (!m) return null;
  const hit = ZIP_TABLE[m[1]];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

/** Equirectangular distance in km — fine for picking among shops. */
function km(a: Coords, b: Coords): number {
  const dLat = a.lat - b.lat;
  const dLng = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111.32;
}

/** Nearest shop to a point; null if every shop with a radius is out of range. */
export function nearestShop(point: Coords, shops: ShopGeo[]): string | null {
  let best: { id: string; d: number } | null = null;
  for (const s of shops) {
    if (s.latitude == null || s.longitude == null) continue;
    const d = km(point, { lat: Number(s.latitude), lng: Number(s.longitude) });
    if (s.serviceRadiusKm != null && d > s.serviceRadiusKm) continue;
    if (!best || d < best.d) best = { id: s.id, d };
  }
  return best?.id ?? null;
}

/** Extract coords from a US Census geocoder response, or null.
 *  Census returns coordinates as { x: longitude, y: latitude }. */
// deno-lint-ignore no-explicit-any
export function parseGeocodeResponse(body: any): Coords | null {
  const c = body?.result?.addressMatches?.[0]?.coordinates;
  if (!c || typeof c.y !== "number" || typeof c.x !== "number") return null;
  return { lat: c.y, lng: c.x };
}

import { db, schema } from "../db/client.ts";

/** Best-effort geocode via the free US Census geocoder (no API key required).
 *  Returns null on any failure/timeout/no-match — never throws. US addresses
 *  only; misses fall back to the primary shop in routeOrderToShop. */
export async function geocodeAddress(address: string): Promise<Coords | null> {
  if (!address.trim()) return null;
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${
      encodeURIComponent(address)
    }&benchmark=Public_AR_Current&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return parseGeocodeResponse(await res.json());
  } catch {
    return null;
  }
}

/** Resolve routing coords: a geocodable address wins; else the ZIP centroid;
 *  else null. Best-effort, never throws. */
export async function resolveRoutingCoords(
  address: string | null,
  zip?: string | null,
): Promise<Coords | null> {
  const fromAddr = address ? await geocodeAddress(address) : null;
  if (fromAddr) return fromAddr;
  return zip ? zipToCoords(zip) : null;
}

/**
 * Resolve which shop an order belongs to from its service address (or, if no
 * address geocodes, its ZIP centroid).
 * Best-effort: geocode failure or no match falls back to the primary shop
 * (san-jose) with autoRouted=false so staff can review.
 */
export async function routeOrderToShop(
  address: string | null,
  zip?: string | null,
): Promise<{ shopId: string; coords: Coords | null; autoRouted: boolean }> {
  const shops = await db.select({
    id: schema.shops.id,
    slug: schema.shops.slug,
    latitude: schema.shops.latitude,
    longitude: schema.shops.longitude,
    serviceRadiusKm: schema.shops.serviceRadiusKm,
  }).from(schema.shops);

  const primary = shops.find((s) => s.slug === "san-jose") ?? shops[0];
  if (!primary) throw new Error("No shops configured in database");

  const coords = await resolveRoutingCoords(address, zip);
  const matchedId = coords ? nearestShop(coords, shops) : null;
  if (matchedId) return { shopId: matchedId, coords, autoRouted: true };
  return { shopId: primary.id, coords, autoRouted: false };
}

/**
 * Review note for an order whose shop was NOT auto-routed. Customer orders
 * always carry a service address, so a non-auto-route means the address
 * either failed to geocode or fell outside every shop's service radius — the
 * order landed on the primary shop as a fallback and a human should confirm
 * the assignment. Returns null when the order auto-routed (nothing to review).
 */
export function routingReviewNote(
  r: { autoRouted: boolean; coords: Coords | null },
): string | null {
  if (r.autoRouted) return null;
  return r.coords
    ? "⚠ Auto-routed to the default shop — the service address is outside every shop's service radius. Verify the assigned shop."
    : "⚠ Auto-routed to the default shop — could not geocode the service address. Verify the assigned shop.";
}
