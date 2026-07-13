import { Hono } from "hono";
import { z } from "zod";
import {
  type PartResearchInput,
  type PartResearchResult,
  researchPartNumbers,
} from "@hmls/agent/part-number-research";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";

type ApiError = { error: { code: string; message: string; retryAfterSeconds?: number } };
type ResearchPartNumbers = (input: PartResearchInput) => Promise<PartResearchResult>;

const COOLDOWN_MS = 60_000;
const lookupStartedAt = new Map<string, number>();

export const partLookupInputSchema = z.object({
  vehicle: z.object({
    year: z.string().trim().min(1).max(4),
    make: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
  }).strict(),
  services: z.array(
    z.object({
      itemId: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(200),
    }).strict(),
  ).min(1).max(20),
}).strict();

function cooldownKey(userId: string, input: PartResearchInput): string {
  return `${userId}\u0000${JSON.stringify(input)}`;
}

function cooldownRemainingMs(key: string, now: number): number {
  const startedAt = lookupStartedAt.get(key);
  if (startedAt === undefined) return 0;
  const remaining = COOLDOWN_MS - (now - startedAt);
  if (remaining <= 0) lookupStartedAt.delete(key);
  return Math.max(0, remaining);
}

export function resetPartLookupCooldownForTests(): void {
  lookupStartedAt.clear();
}

export function createPartReferenceLookup(
  research: ResearchPartNumbers = researchPartNumbers,
) {
  const router = new Hono<AdminEnv>();
  router.use("*", requireAdmin);

  router.post("/lookup", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = partLookupInputSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json<ApiError>(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Vehicle year/make/model and at least one Tech prep service are required",
          },
        },
        400,
      );
    }

    const input: PartResearchInput = parsed.data;
    const key = cooldownKey(c.get("authUser").id, input);
    const remainingMs = cooldownRemainingMs(key, Date.now());
    if (remainingMs > 0) {
      const retryAfterSeconds = Math.ceil(remainingMs / 1_000);
      return c.json<ApiError>(
        {
          error: {
            code: "LOOKUP_COOLDOWN",
            message: `Part lookup is cooling down. Try again in ${retryAfterSeconds}s`,
            retryAfterSeconds,
          },
        },
        429,
      );
    }

    lookupStartedAt.set(key, Date.now());
    try {
      const result = await research(input);
      const referenceCount = Object.values(result.referencesByItemId).reduce(
        (sum, references) => sum + references.length,
        0,
      );
      return c.json({
        referencesByItemId: result.referencesByItemId,
        lookup: {
          status: referenceCount > 0 ? "found" as const : "no_results" as const,
          referenceCount,
          emptyGroups: result.emptyGroups,
          evidenceCount: result.evidenceCount,
          sourceCount: result.sourceCount,
        },
      });
    } catch (error) {
      lookupStartedAt.delete(key);
      return c.json<ApiError>(
        {
          error: {
            code: "LOOKUP_FAILED",
            message: error instanceof Error ? error.message : "Part lookup failed",
          },
        },
        502,
      );
    }
  });

  return router;
}

export const partReferenceLookup = createPartReferenceLookup();
