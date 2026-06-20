// The Fixo brain as a typed service contract.
//
// HMLS (and, later, other shops) call this to diagnose / estimate; the shop
// reports the real-world outcome back via `recordOutcome`, keyed by
// `predictionId`. That (prediction → confirmed truth) link is the calibration
// loop's join key.
//
// Phase 0 — full replace, IN-PROCESS (decided 2026-06-20):
//   HMLS and Fixo run in the same Deno Deploy app, so a network hop buys no
//   isolation and only adds latency in the customer-chat hot path. This is an
//   in-process module the HMLS agent imports and calls directly.
//
//   The decoupling lives in the CONTRACT, not the transport: every request /
//   response below is a plain JSON-serializable DTO and the brain returns a
//   `predictionId`. So lifting this behind an HTTP route at productization
//   (Phase 2, for external shops) is a transport swap — wrap these three
//   functions in routes and give HMLS a `fetch` client that implements
//   `BrainService`. The callsites don't change.
//
// GUARDRAIL: keep these DTOs serializable. No Drizzle rows, class instances,
// closures, or DB handles across this boundary — that's what keeps the HTTP
// lift a swap instead of a rewrite.

import type { DiagnosticCandidateSystem, OrderItem, VehicleInfo } from "@hmls/shared/db/schema";

/** A stable id minted by the brain on every diagnose / estimate call. The shop
 *  echoes it back in `recordOutcome` so the prediction and its real-world
 *  result can be joined for calibration. Prefixed for greppability in logs. */
export function newPredictionId(): string {
  return `pred_${crypto.randomUUID()}`;
}

export interface DiagnoseRequest {
  vehicle: VehicleInfo;
  symptom: string;
  dtcs?: string[];
  photoUrls?: string[];
}

export interface DiagnoseResult {
  predictionId: string;
  candidateSystems: DiagnosticCandidateSystem[];
  rootCause?: string;
  tests?: string[];
}

export interface EstimateRequest {
  /** Links the estimate to a prior `diagnose` call when one happened. */
  predictionId?: string;
  vehicle: VehicleInfo;
  /** The diagnosis / job description the estimate is priced against. */
  diagnosis: string;
}

export interface EstimateResult {
  predictionId: string;
  items: OrderItem[];
  subtotalCents: number;
  priceRangeLowCents: number;
  priceRangeHighCents: number;
}

export interface OutcomeRequest {
  predictionId: string;
  /** What the mechanic confirmed it actually was. */
  confirmedDiagnosis: string;
  /** What the job actually cost, when known. */
  actualCostCents?: number;
}

/** The Fixo brain contract. Phase 0: an in-process implementation called
 *  directly by HMLS. Phase 2: the same shape behind HTTP for external shops. */
export interface BrainService {
  diagnose(req: DiagnoseRequest): Promise<DiagnoseResult>;
  estimate(req: EstimateRequest): Promise<EstimateResult>;
  recordOutcome(req: OutcomeRequest): Promise<void>;
}
