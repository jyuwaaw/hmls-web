export type OnlinePartReference = {
  partName: string;
  brand: string;
  partNumber: string;
  source: "google_search";
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

type CacheEnvelope = {
  version: 1;
  fingerprint: string;
  savedAt: string;
  referencesByItemId: OnlinePartReferencesByItemId;
};

const CACHE_PREFIX = "hmls:tech-prep-part-references:v1";

export function partReferenceCacheKey(
  shopId: string,
  orderId: number | string,
): string {
  return `${CACHE_PREFIX}:${shopId}:${orderId}`;
}

export function partReferenceFingerprint(
  vehicle: PartReferenceVehicle,
  services: readonly PartReferenceService[],
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
  });
}

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function safeHttpsUrl(value: unknown): string | null {
  const raw = nonEmptyString(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.href;
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
  const sourceUrl = safeHttpsUrl(raw.sourceUrl);
  const searchedAt = nonEmptyString(raw.searchedAt, 50);
  const partType =
    raw.partType === "oem" || raw.partType === "aftermarket"
      ? raw.partType
      : null;
  if (
    !partName ||
    !brand ||
    !partNumber ||
    raw.source !== "google_search" ||
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
    source: "google_search",
    engineVariant,
    partType,
    fitmentNote,
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
    if (!itemId.trim() || itemId.length > 120 || !Array.isArray(references)) {
      return null;
    }
    const parsedReferences = references.map(parseReference);
    if (
      parsedReferences.some((reference) => reference === null) ||
      parsedReferences.length > 36
    )
      return null;
    result[itemId] = parsedReferences as OnlinePartReference[];
  }
  return result;
}

export function parsePartReferenceCache(
  raw: string | null,
  fingerprint: string,
): OnlinePartReferencesByItemId | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      parsed.fingerprint !== fingerprint ||
      !parsed.referencesByItemId ||
      typeof parsed.referencesByItemId !== "object" ||
      Array.isArray(parsed.referencesByItemId)
    )
      return null;

    return validateOnlinePartReferences(parsed.referencesByItemId);
  } catch {
    return null;
  }
}

export function readPartReferenceCache(
  storage: StorageLike,
  key: string,
  fingerprint: string,
): OnlinePartReferencesByItemId | null {
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
  referencesByItemId: OnlinePartReferencesByItemId,
  savedAt = new Date().toISOString(),
): boolean {
  const validated = validateOnlinePartReferences(referencesByItemId);
  if (!validated) return false;
  const envelope: CacheEnvelope = {
    version: 1,
    fingerprint,
    savedAt,
    referencesByItemId: validated,
  };
  try {
    storage.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}
