import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hmls", "agent", "olp-client"]);

const OLP_WORKER_URL = Deno.env.get("OLP_WORKER_URL") ??
  "https://olp-worker.spencerzhyp.workers.dev";
const OLP_WORKER_SECRET = Deno.env.get("OLP_WORKER_SECRET") ?? "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (OLP_WORKER_SECRET) {
    headers["Authorization"] = `Bearer ${OLP_WORKER_SECRET}`;
  }
  return headers;
}

async function olpPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${OLP_WORKER_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`OLP Worker request failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- Interfaces (same shapes as olp-sqlite.ts) ---

export interface OlpVehicle {
  id: number;
  make: string;
  model: string;
  year_range: string;
  engine: string;
  fuel_type: string | null;
}

export interface OlpLaborTime {
  name: string;
  /** Normalized job slug — the join key to repair_jobs (see getRepairJobs) */
  slug: string;
  category: string;
  labor_hours: number;
  vehicle_id: number;
}

/** Labor time result with provenance metadata for debugging */
export interface LaborTimeResult {
  name: string;
  slug: string;
  category: string;
  labor_hours: number;
  vehicle_id: number;
  /** How this result was matched / where it came from */
  sourceMeta: {
    /** Always "OLP" for now */
    source: "OLP";
    /** The OLP service name that was matched */
    matchedService: string;
    /** The OLP category field */
    matchedCategory: string;
    /** 0.0–1.0 match quality score */
    confidence: number;
    /** What we queried with */
    query: {
      vehicleIds: number[];
      serviceWords: string[];
      category?: string;
      matchAny: boolean;
    };
    /** Assumptions made during resolution */
    assumptions: string[];
    /** When this was resolved */
    retrievedAt: string;
  };
}

export interface OlpCategory {
  category: string;
  count: number;
}

// --- Query functions ---

export async function findVehicles(
  make: string,
  model: string,
  year: number,
  fuzzy = false,
): Promise<OlpVehicle[]> {
  logger.debug("findVehicles", { make, model, year, fuzzy });
  const data = await olpPost<{ vehicles: OlpVehicle[] }>("/vehicles", {
    make,
    model,
    year,
    fuzzy,
  });
  return data.vehicles;
}

export async function searchLaborTimes(
  vehicleIds: number[],
  serviceWords: string[],
  category: string | undefined,
  matchAny = false,
): Promise<LaborTimeResult[]> {
  if (vehicleIds.length === 0 || serviceWords.length === 0) return [];

  const data = await olpPost<{ laborTimes: OlpLaborTime[] }>("/labor-times", {
    vehicleIds,
    serviceWords,
    category,
    matchAny,
  });
  const raw = data.laborTimes ?? [];

  // Compute confidence based on string overlap between query and result
  function computeConfidence(result: OlpLaborTime): number {
    const resultText = `${result.name} ${result.category}`.toLowerCase();
    const words = serviceWords.map((w) => w.toLowerCase());
    const matched = words.filter((w) => resultText.includes(w));
    if (words.length === 0) return 0;
    // Also penalize if category doesn't match
    const categoryOk = category
      ? result.category.toLowerCase().includes(category.toLowerCase())
      : true;
    const wordScore = matched.length / words.length;
    return categoryOk ? Math.round(wordScore * 100) / 100 : Math.round(wordScore * 0.7 * 100) / 100;
  }

  const assumptions: string[] = [];
  if (!category) assumptions.push("category filter not provided");
  if (vehicleIds.length > 1) assumptions.push(`multiple vehicles matched (${vehicleIds.length})`);

  const retrievedAt = new Date().toISOString();

  return raw.map((r) => ({
    ...r,
    sourceMeta: {
      source: "OLP" as const,
      matchedService: r.name,
      matchedCategory: r.category,
      confidence: computeConfidence(r),
      query: { vehicleIds, serviceWords, category, matchAny },
      assumptions,
      retrievedAt,
    },
  }));
}

export async function getCategoryBreakdown(
  vehicleIds: number[],
): Promise<OlpCategory[]> {
  if (vehicleIds.length === 0) return [];
  logger.debug("getCategoryBreakdown", { vehicleIds: vehicleIds.length });
  const data = await olpPost<{ categories: OlpCategory[] }>("/categories", {
    vehicleIds,
  });
  return data.categories;
}

// --- Repair-job enrichment (vehicle-independent: tools / difficulty / parts) ---

export interface RepairTool {
  name: string;
  specialty?: boolean;
  optional?: boolean;
}

export interface RepairJob {
  slug: string;
  name: string;
  category: string;
  /** 1 (trivial) – 5 (engine-out / specialist) */
  difficulty: number;
  tools: RepairTool[];
  typicalParts: string[];
  /** AI-estimated common fastener sizes — prep hint only, may be null */
  likelySizes: string[] | null;
  /** EV high-voltage job: requires HV-certified tech + insulated PPE + service disconnect */
  hvSafety: boolean;
  notes: string;
}

/**
 * Fetch vehicle-independent job enrichment (tools, difficulty, typical parts,
 * notes) for a set of job slugs — typically the slugs returned by
 * searchLaborTimes(). Excluded jobs (e.g. illegal emissions defeats) are never
 * returned by the worker.
 */
export async function getRepairJobs(slugs: string[]): Promise<RepairJob[]> {
  if (slugs.length === 0) return [];
  logger.debug("getRepairJobs", { slugs: slugs.length });
  const data = await olpPost<{ jobs: RepairJob[] }>("/repair-jobs", {
    slugs: [...new Set(slugs)],
  });
  return data.jobs ?? [];
}
