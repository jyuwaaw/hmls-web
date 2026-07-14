export type OnlinePartReference = {
  partName: string;
  brand: string;
  partNumber: string;
  source: "web_search";
  engineVariant: string;
  partType: "oem" | "aftermarket";
  fitmentNote: string;
  sourceTitle: string;
  sourceUrl: string;
  searchedAt: string;
};

export type OnlinePartReferencesByItemId = Record<
  string,
  OnlinePartReference[]
>;

export type Retailer = "autozone" | "oreilly" | "napa" | "walmart" | "amazon";

type RetailerEntryBase = {
  retailer: Retailer;
  retailerLabel: string;
  partName: string;
  engineVariant: string;
  sourceUrl: string;
};

export type RetailerOfferEntry = RetailerEntryBase & {
  kind: "offer";
  productTitle: string;
  brand: string;
  partNumber: string;
  fitmentNote: string;
  priceCents: number | null;
  rating: number | null;
  sourceTitle: string;
  searchedAt: string;
};

export type RetailerSearchEntry = RetailerEntryBase & {
  kind: "search";
  searchTitle: string;
};

export type RetailerEntry = RetailerOfferEntry | RetailerSearchEntry;
export type RetailerEntriesByItemId = Record<string, RetailerEntry[]>;

export type PartLookupCacheData = {
  referencesByItemId: OnlinePartReferencesByItemId;
  retailerEntriesByItemId: RetailerEntriesByItemId;
};

export type PartReferenceVehicle = {
  year: string;
  make: string;
  model: string;
};

export type PartReferenceService = {
  itemId: string;
  name: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type CacheEnvelope = PartLookupCacheData & {
  version: 3;
  fingerprint: string;
  savedAt: string;
};

const CACHE_PREFIX = "hmls:tech-prep-part-references:v3";
const RETAILER_DOMAINS: Record<Retailer, string> = {
  autozone: "autozone.com",
  oreilly: "oreillyauto.com",
  napa: "napaonline.com",
  walmart: "walmart.com",
  amazon: "amazon.com",
};

export function partReferenceCacheKey(
  shopId: string,
  orderId: number | string,
): string {
  return `${CACHE_PREFIX}:${shopId}:${orderId}`;
}

export function extractPostalCode(location: unknown): string | undefined {
  if (typeof location !== "string") return undefined;
  return location.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
}

export function partReferenceFingerprint(
  vehicle: PartReferenceVehicle,
  services: readonly PartReferenceService[],
  postalCode?: string,
): string {
  const normalize = (value: string) => value.trim().toLowerCase();
  return JSON.stringify({
    vehicle: {
      year: normalize(vehicle.year),
      make: normalize(vehicle.make),
      model: normalize(vehicle.model),
    },
    services: services
      .map((service) => ({
        itemId: service.itemId.trim(),
        name: normalize(service.name),
      }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    searchLocation: postalCode ?? "san-jose-ca",
  });
}

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function safeHttpsUrl(value: unknown): URL | null {
  const raw = nonEmptyString(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function parseReference(value: unknown): OnlinePartReference | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const partName = nonEmptyString(raw.partName, 200);
  const brand = nonEmptyString(raw.brand, 100);
  const partNumber = nonEmptyString(raw.partNumber, 120);
  const engineVariant = nonEmptyString(raw.engineVariant, 160);
  const fitmentNote = nonEmptyString(raw.fitmentNote, 500);
  const sourceTitle = nonEmptyString(raw.sourceTitle, 200);
  const sourceUrl = safeHttpsUrl(raw.sourceUrl)?.href ?? null;
  const searchedAt = nonEmptyString(raw.searchedAt, 50);
  const partType =
    raw.partType === "oem" || raw.partType === "aftermarket"
      ? raw.partType
      : null;
  if (
    !partName ||
    !brand ||
    !partNumber ||
    raw.source !== "web_search" ||
    !engineVariant ||
    !partType ||
    !fitmentNote ||
    !sourceTitle ||
    !sourceUrl ||
    !searchedAt
  )
    return null;
  return {
    partName,
    brand,
    partNumber,
    source: "web_search",
    engineVariant,
    partType,
    fitmentNote,
    sourceTitle,
    sourceUrl,
    searchedAt,
  };
}

function parseRetailer(value: unknown): Retailer | null {
  return value === "autozone" ||
    value === "oreilly" ||
    value === "napa" ||
    value === "walmart" ||
    value === "amazon"
    ? value
    : null;
}

function retailerUrl(value: unknown, retailer: Retailer): string | null {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain = RETAILER_DOMAINS[retailer];
  return hostname === domain || hostname.endsWith(`.${domain}`)
    ? url.href
    : null;
}

function parseRetailerEntry(value: unknown): RetailerEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const retailer = parseRetailer(raw.retailer);
  if (!retailer) return null;
  const retailerLabel = nonEmptyString(raw.retailerLabel, 60);
  const partName = nonEmptyString(raw.partName, 200);
  const engineVariant = nonEmptyString(raw.engineVariant, 160);
  const sourceUrl = retailerUrl(raw.sourceUrl, retailer);
  if (!retailerLabel || !partName || !engineVariant || !sourceUrl) return null;

  if (raw.kind === "search") {
    const searchTitle = nonEmptyString(raw.searchTitle, 100);
    return searchTitle
      ? {
          kind: "search",
          retailer,
          retailerLabel,
          partName,
          engineVariant,
          searchTitle,
          sourceUrl,
        }
      : null;
  }
  if (raw.kind !== "offer") return null;

  const productTitle = nonEmptyString(raw.productTitle, 300);
  const brand = nonEmptyString(raw.brand, 100);
  const partNumber = nonEmptyString(raw.partNumber, 120);
  const fitmentNote = nonEmptyString(raw.fitmentNote, 500);
  const sourceTitle = nonEmptyString(raw.sourceTitle, 200);
  const searchedAt = nonEmptyString(raw.searchedAt, 50);
  const priceCents =
    raw.priceCents === null ||
    (Number.isInteger(raw.priceCents) && Number(raw.priceCents) >= 0)
      ? (raw.priceCents as number | null)
      : undefined;
  const rating =
    raw.rating === null ||
    (typeof raw.rating === "number" &&
      Number.isFinite(raw.rating) &&
      raw.rating >= 0 &&
      raw.rating <= 5)
      ? (raw.rating as number | null)
      : undefined;
  if (
    !productTitle ||
    !brand ||
    !partNumber ||
    !fitmentNote ||
    !sourceTitle ||
    !searchedAt ||
    priceCents === undefined ||
    rating === undefined ||
    (retailer === "amazon" && (rating === null || rating < 4))
  )
    return null;
  return {
    kind: "offer",
    retailer,
    retailerLabel,
    partName,
    engineVariant,
    productTitle,
    brand,
    partNumber,
    fitmentNote,
    priceCents,
    rating,
    sourceTitle,
    sourceUrl,
    searchedAt,
  };
}

export function validateOnlinePartReferences(
  value: unknown,
): OnlinePartReferencesByItemId | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: OnlinePartReferencesByItemId = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return null;
  for (const [itemId, references] of entries) {
    if (!itemId.trim() || itemId.length > 120 || !Array.isArray(references))
      return null;
    const parsed = references.map(parseReference);
    if (parsed.some((reference) => reference === null) || parsed.length > 36)
      return null;
    result[itemId] = parsed as OnlinePartReference[];
  }
  return result;
}

export function validateRetailerEntries(
  value: unknown,
): RetailerEntriesByItemId | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: RetailerEntriesByItemId = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return null;
  for (const [itemId, retailerEntries] of entries) {
    if (
      !itemId.trim() ||
      itemId.length > 120 ||
      !Array.isArray(retailerEntries)
    )
      return null;
    const parsed = retailerEntries.map(parseRetailerEntry);
    if (parsed.some((entry) => entry === null) || parsed.length > 60)
      return null;
    const validEntries = parsed as RetailerEntry[];
    const groups = new Map<string, RetailerEntry[]>();
    for (const entry of validEntries) {
      const key = entry.engineVariant.trim().toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length > 5) return null;
      const offerCounts = new Map<Retailer, number>();
      for (const entry of group) {
        if (entry.kind !== "offer") continue;
        const count = (offerCounts.get(entry.retailer) ?? 0) + 1;
        if (count > 2) return null;
        offerCounts.set(entry.retailer, count);
      }
    }
    result[itemId] = validEntries;
  }
  return result;
}

export function validatePartLookupData(
  referencesByItemId: unknown,
  retailerEntriesByItemId: unknown,
): PartLookupCacheData | null {
  const references = validateOnlinePartReferences(referencesByItemId);
  const retailerEntries = validateRetailerEntries(retailerEntriesByItemId);
  return references && retailerEntries
    ? {
        referencesByItemId: references,
        retailerEntriesByItemId: retailerEntries,
      }
    : null;
}

export function parsePartReferenceCache(
  raw: string | null,
  fingerprint: string,
): PartLookupCacheData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 3 || parsed.fingerprint !== fingerprint) return null;
    return validatePartLookupData(
      parsed.referencesByItemId,
      parsed.retailerEntriesByItemId,
    );
  } catch {
    return null;
  }
}

export function readPartReferenceCache(
  storage: StorageLike,
  key: string,
  fingerprint: string,
): PartLookupCacheData | null {
  try {
    return parsePartReferenceCache(storage.getItem(key), fingerprint);
  } catch {
    return null;
  }
}

export function writePartReferenceCache(
  storage: StorageLike,
  key: string,
  fingerprint: string,
  data: PartLookupCacheData,
  savedAt = new Date().toISOString(),
): boolean {
  const validated = validatePartLookupData(
    data.referencesByItemId,
    data.retailerEntriesByItemId,
  );
  if (!validated) return false;
  const envelope: CacheEnvelope = {
    version: 3,
    fingerprint,
    savedAt,
    ...validated,
  };
  try {
    storage.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}
