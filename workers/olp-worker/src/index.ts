export interface Env {
  OLP_DB: D1Database;
  WORKER_SECRET: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function json(data: unknown, status = 200): Response {
  return corsResponse(JSON.stringify(data), status);
}

function checkAuth(request: Request, env: Env): boolean {
  if (!env.WORKER_SECRET) return true; // Auth disabled if secret not set
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const [scheme, token] = auth.split(" ", 2);
  return scheme === "Bearer" && token === env.WORKER_SECRET;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Auth check
    if (!checkAuth(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    switch (url.pathname) {
      case "/vehicles":
        return handleVehicles(env, body);
      case "/labor-times":
        return handleLaborTimes(env, body);
      case "/categories":
        return handleCategories(env, body);
      case "/repair-jobs":
        return handleRepairJobs(env, body);
      default:
        return json({ error: "Not found" }, 404);
    }
  },
};

// --- /vehicles ---
// Body: { make: string, model: string, year: number, fuzzy?: boolean }

async function handleVehicles(env: Env, body: Record<string, unknown>): Promise<Response> {
  const make = body.make as string;
  const model = body.model as string;
  const year = body.year as number;
  const fuzzy = Boolean(body.fuzzy);

  if (!make || !model || !year) {
    return json({ error: "make, model, and year are required" }, 400);
  }

  // Normalize: strip hyphens/spaces so "CRV" matches "CR-V", "F150" matches "F-150", etc.
  const normMake = make.replace(/[-\s]/g, "");
  const normModel = model.replace(/[-\s]/g, "");
  const makePattern = fuzzy ? `%${normMake}%` : normMake;
  const modelPattern = fuzzy ? `%${normModel}%` : normModel;

  const result = await env.OLP_DB.prepare(
    `SELECT id, make, model, year_range, year_start, year_end, engine, fuel_type
     FROM olp_vehicles
     WHERE REPLACE(make, '-', '') LIKE ? COLLATE NOCASE
       AND REPLACE(REPLACE(model, '-', ''), ' ', '') LIKE ? COLLATE NOCASE
       AND year_start <= ?
       AND year_end >= ?`,
  )
    .bind(makePattern, modelPattern, year, year)
    .all();

  return json({ vehicles: result.results });
}

// --- /labor-times ---
// Body: { vehicleIds: number[], serviceWords: string[], category?: string, matchAny?: boolean }

async function handleLaborTimes(env: Env, body: Record<string, unknown>): Promise<Response> {
  const vehicleIds = body.vehicleIds as number[];
  const serviceWords = body.serviceWords as string[];
  const category = body.category as string | undefined;
  const matchAny = Boolean(body.matchAny);

  if (!Array.isArray(vehicleIds) || vehicleIds.length === 0) {
    return json({ laborTimes: [] });
  }
  if (!Array.isArray(serviceWords) || serviceWords.length === 0) {
    return json({ laborTimes: [] });
  }

  // D1 supports up to 100 items in an IN clause — current queries pass up to ~20 IDs
  const idPlaceholders = vehicleIds.map(() => "?").join(",");

  let nameCondition: string;
  if (matchAny) {
    nameCondition = `(${serviceWords.map(() => "name LIKE ? COLLATE NOCASE").join(" OR ")})`;
  } else {
    nameCondition = serviceWords.map(() => "name LIKE ? COLLATE NOCASE").join(" AND ");
  }

  const categoryCondition = category ? " AND category LIKE ? COLLATE NOCASE" : "";

  const sql = `SELECT name, slug, category, labor_hours, vehicle_id
     FROM olp_labor_times
     WHERE vehicle_id IN (${idPlaceholders})
       AND ${nameCondition}${categoryCondition}
     LIMIT 30`;

  const params: (string | number)[] = [
    ...vehicleIds,
    ...serviceWords.map((w) => `%${w}%`),
  ];
  if (category) params.push(category);

  const stmt = env.OLP_DB.prepare(sql);
  const result = await stmt.bind(...params).all();

  return json({ laborTimes: result.results });
}

// --- /categories ---
// Body: { vehicleIds: number[] }

async function handleCategories(env: Env, body: Record<string, unknown>): Promise<Response> {
  const vehicleIds = body.vehicleIds as number[];

  if (!Array.isArray(vehicleIds) || vehicleIds.length === 0) {
    return json({ categories: [] });
  }

  const placeholders = vehicleIds.map(() => "?").join(",");
  const result = await env.OLP_DB.prepare(
    `SELECT category, COUNT(*) as count
     FROM olp_labor_times
     WHERE vehicle_id IN (${placeholders})
     GROUP BY category
     ORDER BY category`,
  )
    .bind(...vehicleIds)
    .all();

  return json({ categories: result.results });
}

// --- /repair-jobs ---
// Body: { slugs: string[] }
// Vehicle-independent job enrichment (tools / difficulty / typical parts / notes).
// Excluded jobs (e.g. illegal emissions defeats) are never returned.

function safeParse(v: unknown, fallback: unknown): unknown {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function handleRepairJobs(env: Env, body: Record<string, unknown>): Promise<Response> {
  const slugs = body.slugs as string[];

  if (!Array.isArray(slugs) || slugs.length === 0) {
    return json({ jobs: [] });
  }

  // D1 supports up to 100 items in an IN clause
  const capped = slugs.slice(0, 100);
  const placeholders = capped.map(() => "?").join(",");

  const result = await env.OLP_DB.prepare(
    `SELECT slug, name, category, difficulty, tools, typical_parts, likely_sizes, hv_safety, notes
     FROM repair_jobs
     WHERE slug IN (${placeholders})
       AND excluded = 0`,
  )
    .bind(...capped)
    .all();

  const jobs = (result.results as Record<string, unknown>[]).map((r) => ({
    slug: r.slug,
    name: r.name,
    category: r.category,
    difficulty: r.difficulty,
    tools: safeParse(r.tools, []),
    typicalParts: safeParse(r.typical_parts, []),
    likelySizes: safeParse(r.likely_sizes, null),
    hvSafety: r.hv_safety === 1,
    notes: r.notes ?? "",
  }));

  return json({ jobs });
}
