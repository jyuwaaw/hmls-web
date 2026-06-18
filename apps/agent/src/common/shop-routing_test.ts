import { assertEquals } from "@std/assert";
import { nearestShop, parseGeocodeResponse } from "./shop-routing.ts";

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
