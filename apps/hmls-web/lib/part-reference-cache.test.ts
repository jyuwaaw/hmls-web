import { describe, expect, it } from "bun:test";
import {
  extractPostalCode,
  type OnlinePartReference,
  type PartLookupCacheData,
  parsePartReferenceCache,
  partReferenceCacheKey,
  partReferenceFingerprint,
  readPartReferenceCache,
  validateRetailerEntries,
  writePartReferenceCache,
} from "./part-reference-cache";

const vehicle = { year: "2018", make: "Toyota", model: "Camry" };
const services = [{ itemId: "belt", name: "Serpentine Belt Replacement" }];
const fingerprint = partReferenceFingerprint(vehicle, services, "95113");
const reference: OnlinePartReference = {
  partName: "Serpentine Belt Replacement",
  brand: "Toyota",
  partNumber: "90916-A2027",
  source: "web_search",
  engineVariant: "2.5L I4",
  partType: "oem",
  fitmentNote: "2.5L catalog fitment",
  sourceTitle: "Toyota Parts",
  sourceUrl: "https://parts.example/oem",
  searchedAt: "2026-07-13T00:00:00.000Z",
};
const result: PartLookupCacheData = {
  referencesByItemId: { belt: [reference] },
  retailerEntriesByItemId: {
    belt: [
      {
        kind: "offer",
        retailer: "autozone",
        retailerLabel: "AutoZone",
        partName: "Serpentine Belt Replacement",
        engineVariant: "2.5L I4",
        productTitle: "Gates Serpentine Belt",
        brand: "Gates",
        partNumber: "K060615",
        fitmentNote: "2018 Camry fitment",
        priceCents: 2499,
        rating: null,
        sourceTitle: "AutoZone",
        sourceUrl: "https://www.autozone.com/belts/k060615",
        searchedAt: "2026-07-13T00:00:00.000Z",
      },
      {
        kind: "search",
        retailer: "amazon",
        retailerLabel: "Amazon",
        partName: "Serpentine Belt Replacement",
        engineVariant: "2.5L I4",
        searchTitle: "Search Amazon",
        sourceUrl: "https://www.amazon.com/s?k=90916-A2027",
      },
    ],
  },
};

function memoryStorage(
  options: { failRead?: boolean; failWrite?: boolean } = {},
) {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      if (options.failRead) throw new Error("blocked");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.failWrite) throw new Error("blocked");
      values.set(key, value);
    },
  };
}

describe("part-reference browser cache", () => {
  it("uses v3 shop and order scope in the cache key", () => {
    expect(partReferenceCacheKey("shop-a", 554)).toBe(
      "hmls:tech-prep-part-references:v3:shop-a:554",
    );
  });

  it("extracts only a five-digit ZIP and fingerprints location", () => {
    expect(extractPostalCode("123 Main St, San Jose, CA 95113-1234")).toBe(
      "95113",
    );
    expect(extractPostalCode("San Jose, CA")).toBeUndefined();
    expect(
      partReferenceFingerprint(
        { year: " 2018 ", make: "TOYOTA", model: "Camry" },
        services,
        "95113",
      ),
    ).toBe(fingerprint);
    expect(partReferenceFingerprint(vehicle, services, "92618")).not.toBe(
      fingerprint,
    );
  });

  it("round-trips references and retailer entries", () => {
    const storage = memoryStorage();
    const key = partReferenceCacheKey("shop-a", 554);
    expect(writePartReferenceCache(storage, key, fingerprint, result)).toBe(
      true,
    );
    expect(readPartReferenceCache(storage, key, fingerprint)).toEqual(result);
  });

  it("rejects unsafe or mismatched retailer URLs and low-rated Amazon offers", () => {
    const offer = result.retailerEntriesByItemId.belt[0];
    expect(
      validateRetailerEntries({
        belt: [{ ...offer, sourceUrl: "https://autozone.com.evil.example/p" }],
      }),
    ).toBeNull();
    expect(
      validateRetailerEntries({
        belt: [
          {
            ...offer,
            kind: "offer",
            retailer: "amazon",
            retailerLabel: "Amazon",
            sourceUrl: "https://www.amazon.com/p",
            rating: 3.9,
          },
        ],
      }),
    ).toBeNull();
  });

  it("enforces five entries per engine and two offers per retailer", () => {
    const search = result.retailerEntriesByItemId.belt[1];
    expect(
      validateRetailerEntries({
        belt: Array.from({ length: 6 }, (_, index) => ({
          ...search,
          retailer: "amazon",
          searchTitle: `Search Amazon ${index}`,
          sourceUrl: `https://www.amazon.com/s?k=belt${index}`,
        })),
      }),
    ).toBeNull();
    const offer = result.retailerEntriesByItemId.belt[0];
    expect(
      validateRetailerEntries({
        belt: Array.from({ length: 3 }, (_, index) => ({
          ...offer,
          partNumber: `K06061${index}`,
          sourceUrl: `https://www.autozone.com/belts/k06061${index}`,
        })),
      }),
    ).toBeNull();
  });

  it("ignores stale fingerprints and malformed or legacy data", () => {
    const envelope = JSON.stringify({
      version: 3,
      fingerprint,
      savedAt: "2026-07-13T00:00:00.000Z",
      ...result,
    });
    expect(parsePartReferenceCache(envelope, "changed")).toBeNull();
    expect(parsePartReferenceCache("not json", fingerprint)).toBeNull();
    expect(
      parsePartReferenceCache(
        JSON.stringify({ version: 2, fingerprint, ...result }),
        fingerprint,
      ),
    ).toBeNull();
  });

  it("tolerates unavailable browser storage", () => {
    const key = partReferenceCacheKey("shop-a", 554);
    expect(
      readPartReferenceCache(
        memoryStorage({ failRead: true }),
        key,
        fingerprint,
      ),
    ).toBeNull();
    expect(
      writePartReferenceCache(
        memoryStorage({ failWrite: true }),
        key,
        fingerprint,
        result,
      ),
    ).toBe(false);
  });
});
