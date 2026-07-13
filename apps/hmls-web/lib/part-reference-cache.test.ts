import { describe, expect, it } from "bun:test";
import {
  type OnlinePartReference,
  parsePartReferenceCache,
  partReferenceCacheKey,
  partReferenceFingerprint,
  readPartReferenceCache,
  writePartReferenceCache,
} from "./part-reference-cache";

const vehicle = { year: "2018", make: "Toyota", model: "Camry" };
const services = [{ itemId: "belt", name: "Serpentine Belt Replacement" }];
const fingerprint = partReferenceFingerprint(vehicle, services);
const reference: OnlinePartReference = {
  partName: "Serpentine Belt Replacement",
  brand: "Toyota",
  partNumber: "90916-A2027",
  source: "google_search",
  engineVariant: "2.5L I4",
  partType: "oem",
  fitmentNote: "2.5L catalog fitment",
  sourceTitle: "Toyota Parts",
  sourceUrl: "https://parts.example/oem",
  searchedAt: "2026-07-13T00:00:00.000Z",
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
  it("uses shop and order scope in the cache key", () => {
    expect(partReferenceCacheKey("shop-a", 554)).toBe(
      "hmls:tech-prep-part-references:v1:shop-a:554",
    );
  });

  it("fingerprints normalized vehicle and sorted services", () => {
    expect(
      partReferenceFingerprint(
        { year: " 2018 ", make: "TOYOTA", model: "Camry" },
        services,
      ),
    ).toBe(fingerprint);
  });

  it("round-trips a valid result", () => {
    const storage = memoryStorage();
    const key = partReferenceCacheKey("shop-a", 554);
    expect(
      writePartReferenceCache(storage, key, fingerprint, { belt: [reference] }),
    ).toBe(true);
    expect(readPartReferenceCache(storage, key, fingerprint)).toEqual({
      belt: [reference],
    });
  });

  it("ignores stale fingerprints and malformed or unsafe data", () => {
    const envelope = (sourceUrl: string) =>
      JSON.stringify({
        version: 1,
        fingerprint,
        savedAt: "2026-07-13T00:00:00.000Z",
        referencesByItemId: { belt: [{ ...reference, sourceUrl }] },
      });
    expect(
      parsePartReferenceCache(envelope(reference.sourceUrl), "changed"),
    ).toBeNull();
    expect(parsePartReferenceCache("not json", fingerprint)).toBeNull();
    expect(
      parsePartReferenceCache(envelope("javascript:alert(1)"), fingerprint),
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
        { belt: [reference] },
      ),
    ).toBe(false);
  });
});
