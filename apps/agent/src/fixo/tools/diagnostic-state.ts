// apps/agent/src/fixo/tools/diagnostic-state.ts
//
// `update_diagnostic_state` — the one tool the Fixo agent uses to externalize
// what it has learned during a diagnostic session. Reads/writes
// fixo_sessions.diagnostic_state. The state is also injected back into the
// system prompt at the start of every turn (see build-context.ts), so the
// agent always sees its own structured memory before acting.
//
// Merge semantics (chosen so the agent doesn't have to copy the whole state
// each call):
//   intake               — deep-merge keys (preserves earlier fields)
//   visualObservations   — append to visual.observations
//   newDtcs              — append, deduplicating by code
//   candidateSystems     — REPLACE entire list (each turn re-evaluates)
//   newTestsPlanned      — append, deduplicating
//   newTestResults       — append (history matters)
//   rootCause            — replace
//   estimateTiers        — replace entire list
//   appendNote           — append to notes (with "\n" separator)

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type {
  DiagnosticCandidateSystem,
  DiagnosticEstimateTier,
  DiagnosticState,
  DiagnosticTestResult,
} from "@hmls/shared/db/schema";
import type { ToolContext } from "../../common/convert-tools.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hmls", "agent", "fixo", "diagnostic-state"]);

// Match the canonical DiagnosticIntake type but with all fields optional
// at the schema level so the agent can patch one field at a time.
const intakePatchSchema = z
  .object({
    primarySymptom: z.string().optional(),
    onset: z.enum(["always", "intermittent", "cold", "hot", "load", "speed-dep"]).optional(),
    frequency: z.string().optional(),
    warningLights: z.array(z.string()).optional(),
    recentRepairs: z.string().optional(),
    drivable: z.enum(["safe", "limp", "no-start"]).optional(),
  })
  .strict();

const candidateSystemSchema = z.object({
  system: z.string().describe("e.g. 'fuel', 'ignition', 'vacuum', 'cooling', 'brakes'"),
  confidence: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("0=ruled-out, 1=low, 2=medium, 3=high"),
  reasons: z.array(z.string()),
});

const testResultSchema = z.object({
  test: z.string(),
  result: z.string(),
});

const tierEnum = z.enum(["required", "recommended", "maintenance", "optional"]);

const estimateTierSchema = z.object({
  service: z.string(),
  tier: tierEnum,
});

const updateSchema = z
  .object({
    intake: intakePatchSchema
      .optional()
      .describe("Patch the customer-intake stage. Deep-merged with existing intake."),
    visualObservations: z
      .array(z.string())
      .optional()
      .describe("Append visual-inspection observations (from photo analysis)."),
    newDtcs: z
      .array(
        z.object({
          code: z.string().describe("e.g. 'P0171'"),
          freezeFrame: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional()
      .describe("Append OBD-II codes (deduplicated by code)."),
    candidateSystems: z
      .array(candidateSystemSchema)
      .optional()
      .describe(
        "REPLACE the candidate-systems list with the agent's current best ranking. " +
          "Reassess each turn — don't carry stale candidates.",
      ),
    newTestsPlanned: z
      .array(z.string())
      .optional()
      .describe("Append pinpoint tests the agent recommends (deduplicated)."),
    newTestResults: z
      .array(testResultSchema)
      .optional()
      .describe("Append test results the customer or tech reports back."),
    rootCause: z
      .string()
      .optional()
      .describe(
        "Set the most likely root cause once confidence is high enough. " +
          "Do NOT set this until pinpoint tests support a single answer.",
      ),
    estimateTiers: z
      .array(estimateTierSchema)
      .optional()
      .describe("REPLACE the per-service tier mapping for the upcoming estimate."),
    appendNote: z
      .string()
      .optional()
      .describe(
        "Free-form note to append (separated by newline). Use for context the " +
          "structured fields don't cover, e.g. 'customer says shop already replaced plugs'.",
      ),
  })
  .strict();

type UpdateInput = z.infer<typeof updateSchema>;

function dedupeStrings(existing: string[] | undefined, additions: string[]): string[] {
  const seen = new Set<string>(existing ?? []);
  const result = [...(existing ?? [])];
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function dedupeDtcs(
  existing: NonNullable<DiagnosticState["dtcs"]> | undefined,
  additions: NonNullable<DiagnosticState["dtcs"]>,
): NonNullable<DiagnosticState["dtcs"]> {
  const byCode = new Map<string, NonNullable<DiagnosticState["dtcs"]>[number]>();
  for (const e of existing ?? []) byCode.set(e.code, e);
  for (const a of additions) byCode.set(a.code, { ...byCode.get(a.code), ...a });
  return [...byCode.values()];
}

/** Apply a UpdateInput patch to a DiagnosticState, returning the merged result. */
export function mergeDiagnosticState(
  current: DiagnosticState,
  patch: UpdateInput,
): DiagnosticState {
  const next: DiagnosticState = { ...current };

  if (patch.intake) {
    next.intake = { ...(current.intake ?? {}), ...patch.intake };
  }
  if (patch.visualObservations && patch.visualObservations.length > 0) {
    const merged = dedupeStrings(current.visual?.observations, patch.visualObservations);
    next.visual = { observations: merged };
  }
  if (patch.newDtcs && patch.newDtcs.length > 0) {
    next.dtcs = dedupeDtcs(current.dtcs, patch.newDtcs);
  }
  if (patch.candidateSystems !== undefined) {
    next.candidateSystems = patch.candidateSystems as DiagnosticCandidateSystem[];
  }
  if (patch.newTestsPlanned && patch.newTestsPlanned.length > 0) {
    next.testsPlanned = dedupeStrings(current.testsPlanned, patch.newTestsPlanned);
  }
  if (patch.newTestResults && patch.newTestResults.length > 0) {
    const stamped: DiagnosticTestResult[] = patch.newTestResults.map((r) => ({
      ...r,
      recordedAt: new Date().toISOString(),
    }));
    next.testsDone = [...(current.testsDone ?? []), ...stamped];
  }
  if (patch.rootCause !== undefined) {
    next.rootCause = patch.rootCause;
  }
  if (patch.estimateTiers !== undefined) {
    next.estimateTiers = patch.estimateTiers as DiagnosticEstimateTier[];
  }
  if (patch.appendNote && patch.appendNote.length > 0) {
    next.notes = current.notes ? `${current.notes}\n${patch.appendNote}` : patch.appendNote;
  }

  return next;
}

function asToolContext(ctx: unknown): ToolContext | undefined {
  if (ctx && typeof ctx === "object" && "fixoSessionId" in ctx) {
    return ctx as ToolContext;
  }
  return undefined;
}

export const updateDiagnosticStateTool = {
  name: "update_diagnostic_state",
  description: "Update the durable diagnostic state for this Fixo session. Call after every " +
    "step where new evidence comes in (intake answers, photo findings, OBD codes, " +
    "test results, candidate-system reassessment). The state is shown back to you " +
    "in your system prompt next turn — your structured memory of the diagnostic " +
    "so far. Pass only the fields that changed.",
  schema: updateSchema,
  execute: async (params: UpdateInput, rawCtx: unknown) => {
    const ctx = asToolContext(rawCtx);
    if (!ctx?.fixoSessionId) {
      return toolResult({
        success: false,
        error: "no_session",
        message: "fixoSessionId missing from tool context — state not persisted.",
      });
    }

    const sessionId = ctx.fixoSessionId;

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ diagnosticState: schema.fixoSessions.diagnosticState })
        .from(schema.fixoSessions)
        .where(eq(schema.fixoSessions.id, sessionId))
        .for("update")
        .limit(1);

      if (!row) {
        return null;
      }

      const next = mergeDiagnosticState(row.diagnosticState ?? {}, params);
      await tx
        .update(schema.fixoSessions)
        .set({ diagnosticState: next })
        .where(eq(schema.fixoSessions.id, sessionId));
      return next;
    });

    if (!updated) {
      logger.warn("update_diagnostic_state: session not found", { sessionId });
      return toolResult({
        success: false,
        error: "session_not_found",
      });
    }

    return toolResult({
      success: true,
      diagnosticState: updated,
    });
  },
};
