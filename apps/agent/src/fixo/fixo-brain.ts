// In-process implementation of the Fixo brain service (contract: brain-service.ts).
//
// Phase 0: HMLS imports and calls these directly (same Deno Deploy app). They
// take/return the plain serializable DTOs from brain-service.ts and write to
// fixo_predictions, so lifting behind HTTP later is a transport swap.
//
// `estimate` lands with the pricing-engine extraction (Slice 2.3 cont.); this
// file ships `diagnose` (the expert LLM layer) + `recordOutcome` (the loop closer).

import { eq } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { db, dbAdmin, schema } from "../db/client.ts";
import { diagnoseStructured } from "./diagnose-structured.ts";
import {
  type BrainService,
  type DiagnoseRequest,
  type DiagnoseResult,
  newPredictionId,
  type OutcomeRequest,
} from "./brain-service.ts";
import type { DiagnoseOnceInput } from "./run-once-prompt.ts";
import type { StructuredDiagnosis } from "./diagnosis-schema.ts";

const logger = getLogger(["hmls", "agent", "fixo-brain"]);

/** Map DiagnoseRequest.vehicle (VehicleInfo — all fields optional) to the
 *  DiagnoseOnceInput.vehicle shape (year/make/model required). Fallback to
 *  empty string so the agent still gets a usable prompt. */
function toOnceVehicle(req: DiagnoseRequest): DiagnoseOnceInput["vehicle"] {
  if (!req.vehicle.make || !req.vehicle.model) {
    logger.warn("diagnose: incomplete vehicle info", { vehicle: req.vehicle });
  }
  return {
    year: req.vehicle.year ?? "",
    make: req.vehicle.make ?? "",
    model: req.vehicle.model ?? "",
  };
}

/** Cheap, synchronous-ish: mint a prediction id + insert the prediction row
 *  WITHOUT running the agent. For the create_order hot path — fill
 *  predicted_diagnosis async after via fillPrediction.
 *
 *  Uses dbAdmin (NOT the ALS-scoped db) so the insert commits immediately on
 *  its own connection, decoupled from create_order's still-open outer tenant
 *  transaction. Otherwise the row is invisible to the detached fillPrediction /
 *  recordEstimate writes (which run on dbAdmin, a separate connection) and they
 *  update 0 rows. fixo_predictions is a non-RLS'd system table so admin is
 *  correct; an orphan row if the order later rolls back is a harmless
 *  calibration artifact.
 *
 *  ponytail: if a worker/queue ever exists, move fillPrediction there; for now
 *  a detached promise is fine since Deno Deploy doesn't kill the isolate mid-request. */
export async function openPrediction(req: DiagnoseRequest, apiKeyId?: string): Promise<string> {
  const predictionId = newPredictionId();
  await dbAdmin.insert(schema.fixoPredictions).values({
    id: predictionId,
    vehicleInfo: req.vehicle,
    symptom: req.symptom,
    dtcs: req.dtcs ?? null,
    predictedDiagnosis: null,
    apiKeyId: apiKeyId ?? null,
  });
  return predictionId;
}

/** Fill an existing prediction row with the expert structured diagnosis.
 *  Called fire-and-forget from create_order so the ~5s agent run does not
 *  block order creation. Uses dbAdmin: this runs detached and create_order's
 *  outer tenant transaction may still be open, so the ALS-inherited executor
 *  isn't usable here — dbAdmin opens its own connection, and it can see the row
 *  because openPrediction committed it via dbAdmin too. fixo_predictions is a
 *  non-RLS'd system table, so admin is correct. */
export async function fillPrediction(predictionId: string, req: DiagnoseRequest): Promise<void> {
  const structured = await diagnoseStructured({
    vehicle: toOnceVehicle(req),
    symptom: req.symptom,
    dtcs: req.dtcs,
  });
  const updated = await dbAdmin
    .update(schema.fixoPredictions)
    .set({ predictedDiagnosis: structured })
    .where(eq(schema.fixoPredictions.id, predictionId))
    .returning({ id: schema.fixoPredictions.id });

  if (updated.length === 0) {
    logger.warn("fillPrediction: no prediction row matched", { predictionId });
  }
}

/** API path: mint a prediction id + run the full structured diagnosis + store it,
 *  returning BOTH the id (for record_outcome) and the full StructuredDiagnosis.
 *  Used by the MCP `diagnose` tool. */
export async function diagnoseForApi(
  req: DiagnoseRequest,
  apiKeyId?: string,
): Promise<{ predictionId: string; diagnosis: StructuredDiagnosis }> {
  const predictionId = await openPrediction(req, apiKeyId);
  const diagnosis = await diagnoseStructured({
    vehicle: toOnceVehicle(req),
    symptom: req.symptom,
    dtcs: req.dtcs,
  });
  await db
    .update(schema.fixoPredictions)
    .set({ predictedDiagnosis: diagnosis })
    .where(eq(schema.fixoPredictions.id, predictionId));
  return { predictionId, diagnosis };
}

/** Full expert path: open + fill + return the enriched DiagnoseResult.
 *  Use for direct API callers (POST /v1/diagnose) and tests — not for the
 *  create_order hot path (which uses openPrediction + void fillPrediction). */
export const diagnose: BrainService["diagnose"] = async (req) => {
  const predictionId = await openPrediction(req);
  const structured = await diagnoseStructured({
    vehicle: toOnceVehicle(req),
    symptom: req.symptom,
    dtcs: req.dtcs,
  });
  await db
    .update(schema.fixoPredictions)
    .set({ predictedDiagnosis: structured })
    .where(eq(schema.fixoPredictions.id, predictionId));
  return {
    predictionId,
    // confidence is number (0-3) in the schema; DiagnoseResult narrows to 0|1|2|3.
    // Zod enforces the 0-3 range at parse time, so the assertion is runtime-safe.
    candidateSystems: structured.candidate_systems as DiagnoseResult["candidateSystems"],
    rootCause: structured.likely_root_cause,
    tests: structured.recommended_tests,
  };
};

/** Close the loop: stamp the mechanic's confirmed outcome onto the prediction
 *  row by predictionId. Idempotent — re-recording overwrites. Never throws
 *  (callers fire-and-forget on the order-save path); a missing prediction row
 *  is logged, not raised, so a stale/wrong id can't be silently swallowed.
 *
 *  callerKeyId: when set (external MCP path), ownership is enforced — a
 *  prediction opened by a different key OR with no owner at all (NULL apiKeyId,
 *  i.e. an internal create_order prediction) is rejected (logged + no write),
 *  so an external caller holding a UUID can't overwrite internal predictions.
 *  The internal path (no callerKeyId) keeps its ability to write NULL-owner rows.
 *
 *  Uses dbAdmin: called fire-and-forget from PATCH /orders/:id after that
 *  request's tenant-scoped transaction has already committed, so the
 *  ALS-inherited executor would be a closed tx — dbAdmin always opens its own
 *  connection and fixo_predictions is a non-RLS'd system table, so bypass is
 *  correct here. */
export async function recordOutcome(req: OutcomeRequest, callerKeyId?: string): Promise<void> {
  // Ownership check: fetch the prediction's apiKeyId before writing.
  const rows = await dbAdmin
    .select({ apiKeyId: schema.fixoPredictions.apiKeyId })
    .from(schema.fixoPredictions)
    .where(eq(schema.fixoPredictions.id, req.predictionId));

  if (rows.length > 0) {
    const ownerKeyId = rows[0].apiKeyId ?? null;
    // Owned row: only its owning key may write. NULL-owner (internal) row: any
    // external caller (callerKeyId set) is rejected; the internal path (no
    // callerKeyId) may still write it.
    const rejected = ownerKeyId !== null ? ownerKeyId !== callerKeyId : callerKeyId != null;
    if (rejected) {
      logger.warn("record_outcome ownership mismatch", {
        predictionId: req.predictionId,
        ownerKeyId,
        callerKeyId,
      });
      return;
    }
  }

  const updated = await dbAdmin
    .update(schema.fixoPredictions)
    .set({
      confirmedDiagnosis: req.confirmedDiagnosis,
      actualCostCents: req.actualCostCents ?? null,
      outcomeAt: new Date(),
    })
    .where(eq(schema.fixoPredictions.id, req.predictionId))
    .returning({ id: schema.fixoPredictions.id });

  if (updated.length === 0) {
    logger.warn("recordOutcome: no prediction row matched", {
      predictionId: req.predictionId,
    });
  }
}

/** Attach the priced estimate to a prediction row for estimate-vs-actual
 *  calibration. Pricing is the shared OLP engine (skills/estimate/pricing.ts);
 *  this only records the result. Idempotent; logs (never throws) on a missing
 *  row, same as recordOutcome.
 *
 *  Uses dbAdmin: called fire-and-forget from create_order while that tool's
 *  outer tenant-scoped transaction may still be open, so the ALS-inherited
 *  executor isn't usable — dbAdmin opens its own connection and sees the row
 *  because openPrediction committed it via dbAdmin too. fixo_predictions is a
 *  non-RLS'd system table, so admin is correct here. */
export const recordEstimate: BrainService["recordEstimate"] = async (req) => {
  const { predictionId, ...estimate } = req;
  const updated = await dbAdmin
    .update(schema.fixoPredictions)
    .set({ predictedEstimate: estimate })
    .where(eq(schema.fixoPredictions.id, predictionId))
    .returning({ id: schema.fixoPredictions.id });

  if (updated.length === 0) {
    logger.warn("recordEstimate: no prediction row matched", { predictionId });
  }
};

/** The assembled in-process brain. HMLS imports `brain` (or the individual
 *  functions) and calls it directly; Phase 2 wraps the same shape behind HTTP. */
export const brain: BrainService = { diagnose, recordEstimate, recordOutcome };
