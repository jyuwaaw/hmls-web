import { expect, test } from "bun:test";
import { REGIONS } from "./business";

// The shop-seed coords live in apps/agent/migrations/0030_multi_tenancy.sql.
// This pins the web region geo to that seed so the two never drift silently.
// Update BOTH together (this map + the migration) on any real move/rebrand.
const SHOP_SEED: Record<string, { lat: number; lng: number }> = {
  "orange-county": { lat: 33.6484505, lng: -117.8365716 },
  "san-jose": { lat: 37.3361663, lng: -121.890591 },
};

test("every region maps to a known shop slug with matching coords", () => {
  for (const region of Object.values(REGIONS)) {
    const seed = SHOP_SEED[region.shopSlug];
    expect(
      seed,
      `region ${region.id} -> unknown shopSlug ${region.shopSlug}`,
    ).toBeDefined();
    expect(Math.abs(region.geo.latitude - seed.lat)).toBeLessThan(0.01);
    expect(Math.abs(region.geo.longitude - seed.lng)).toBeLessThan(0.01);
  }
});
