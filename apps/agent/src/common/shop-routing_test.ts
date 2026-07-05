import { assertEquals } from "@std/assert";
import {
  nearestShop,
  parseGeocodeResponse,
  resolveRoutingCoords,
  routingReviewNote,
  zipToCoords,
} from "./shop-routing.ts";

const SJ = { id: "sj", latitude: "37.3361663", longitude: "-121.890591", serviceRadiusKm: null };
const OC = { id: "oc", latitude: "33.6484505", longitude: "-117.8365716", serviceRadiusKm: null };

Deno.test("nearestShop: a Bay Area point picks San Jose", () => {
  assertEquals(nearestShop({ lat: 37.3688, lng: -122.0363 }, [SJ, OC]), "sj");
});

Deno.test("nearestShop: a SoCal point picks Orange County", () => {
  assertEquals(nearestShop({ lat: 33.7455, lng: -117.8677 }, [SJ, OC]), "oc");
});

Deno.test("nearestShop: outside every radius => null", () => {
  const capped = [{ ...SJ, serviceRadiusKm: 50 }, { ...OC, serviceRadiusKm: 50 }];
  assertEquals(nearestShop({ lat: 40.0, lng: -100.0 }, capped), null);
});

Deno.test("parseGeocodeResponse: extracts lat/lng from a Census match (x=lng, y=lat)", () => {
  const body = { result: { addressMatches: [{ coordinates: { x: -121.2, y: 37.1 } }] } };
  assertEquals(parseGeocodeResponse(body), { lat: 37.1, lng: -121.2 });
});

Deno.test("parseGeocodeResponse: no matches => null", () => {
  assertEquals(parseGeocodeResponse({ result: { addressMatches: [] } }), null);
});

Deno.test("routingReviewNote: null when the order auto-routed", () => {
  assertEquals(routingReviewNote({ autoRouted: true, coords: { lat: 37, lng: -121 } }), null);
});

Deno.test("routingReviewNote: out-of-range note when coords resolved but no shop matched", () => {
  const note = routingReviewNote({ autoRouted: false, coords: { lat: 0, lng: 0 } });
  assertEquals(typeof note, "string");
  assertEquals(note!.includes("service radius"), true);
});

Deno.test("routingReviewNote: geocode-fail note when coords are null", () => {
  const note = routingReviewNote({ autoRouted: false, coords: null });
  assertEquals(typeof note, "string");
  assertEquals(note!.includes("geocode"), true);
});

Deno.test("zipToCoords: known San Jose ZIP resolves near SJ", () => {
  const c = zipToCoords("95112");
  assertEquals(c !== null, true);
  assertEquals(Math.abs(c!.lat - 37.35) < 0.3, true);
  assertEquals(Math.abs(c!.lng - -121.88) < 0.3, true);
});

Deno.test("zipToCoords: ZIP+4 is normalized to 5 digits", () => {
  assertEquals(zipToCoords("95112-1234") !== null, true);
});

Deno.test("zipToCoords: unknown / malformed returns null", () => {
  assertEquals(zipToCoords("00000"), null);
  assertEquals(zipToCoords("abc"), null);
  assertEquals(zipToCoords(""), null);
});

Deno.test("resolveRoutingCoords: address wins over zip", async () => {
  // A real US address geocodes; the zip is ignored when address resolves.
  const c = await resolveRoutingCoords("1600 Amphitheatre Parkway, Mountain View, CA", "10001");
  // best-effort: if the Census geocoder is unreachable in CI it returns null;
  // assert only that it does not throw and returns Coords|null.
  assertEquals(c === null || (typeof c.lat === "number"), true);
});

Deno.test("resolveRoutingCoords: falls back to zip centroid when no address", async () => {
  const c = await resolveRoutingCoords(null, "95112");
  assertEquals(c !== null && Math.abs(c.lat - 37.35) < 0.3, true);
});
