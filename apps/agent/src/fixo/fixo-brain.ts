// In-process implementation of the Fixo brain service (contract: brain-service.ts).
//
// Phase 0: HMLS imports and calls these directly (same Deno Deploy app). They
// take/return the plain serializable DTOs from brain-service.ts and write to
// fixo_predictions, so lifting behind HTTP later is a transport swap.
//
// `estimate` lands with the pricing-engine extraction (Slice 2.3 cont.); this
// file ships `diagnose` (the rule layer) + `recordOutcome` (the loop closer).

import { eq } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { db, schema } from "../db/client.ts";
import { isolateSystems } from "./tools/system-isolation.ts";
import { type BrainService, type DiagnoseResult, newPredictionId } from "./brain-service.ts";

const logger = getLogger(["hmls", "agent", "fixo-brain"]);

/** Rule-based diagnosis + prediction logging. Ranks candidate systems from the
 *  symptom and records the call as a fixo_predictions row keyed by the returned
 *  predictionId, so recordOutcome can link the real-world result later.
 *
 *  ponytail: v1 scores candidates from symptom keywords only; DTC codes are
 *  stored on the row but not yet mapped to systems (needs lookupObdCode), and
 *  rootCause / tests synthesis (the LLM layer) is a later enhancement. */
export const diagnose: BrainService["diagnose"] = async (req) => {
  const predictionId = newPredictionId();
  const candidateSystems = isolateSystems({ symptomDescription: req.symptom });
  const result: DiagnoseResult = { predictionId, candidateSystems };

  await db.insert(schema.fixoPredictions).values({
    id: predictionId,
    vehicleInfo: req.vehicle,
    symptom: req.symptom,
    dtcs: req.dtcs ?? null,
    predictedDiagnosis: { candidateSystems },
  });

  return result;
};

/** Close the loop: stamp the mechanic's confirmed outcome onto the prediction
 *  row by predictionId. Idempotent — re-recording overwrites. Never throws
 *  (callers fire-and-forget on the order-save path); a missing prediction row
 *  is logged, not raised, so a stale/wrong id can't be silently swallowed. */
export const recordOutcome: BrainService["recordOutcome"] = async (req) => {
  const updated = await db
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
};
