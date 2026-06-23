// mcp/tools.ts — the real Fixo MCP tools, wrapping the in-process brain.
import { z } from "zod";
import { diagnoseForApi, recordOutcome } from "@hmls/agent";
import type { McpTool } from "./jsonrpc.ts";

const diagnoseInput = z.object({
  vehicle: z.object({
    year: z.union([z.number(), z.string()]),
    make: z.string().min(1),
    model: z.string().min(1),
  }),
  symptom: z.string().min(1).max(2000),
  dtcs: z.array(z.string().max(20)).max(20).optional(),
});

const recordOutcomeInput = z.object({
  prediction_id: z.string().min(1),
  confirmed_diagnosis: z.string().min(1),
  actual_cost_cents: z.number().int().nonnegative().optional(),
});

export const fixoMcpTools: McpTool[] = [
  {
    name: "diagnose",
    description:
      "Diagnose a vehicle symptom. Returns a prediction_id (echo it back via record_outcome " +
      "once the real fix is confirmed) and a structured diagnosis (candidate systems, likely " +
      "root cause, recommended tests, safety flags, things to confirm).",
    inputSchema: diagnoseInput,
    execute: async (args, ctx) => {
      const a = args as z.infer<typeof diagnoseInput>;
      // year coerced to string for VehicleInfo (deno check arbitrates if the
      // VehicleInfo.year type differs; coerce here to be safe).
      const { predictionId, diagnosis } = await diagnoseForApi({
        vehicle: { year: String(a.vehicle.year), make: a.vehicle.make, model: a.vehicle.model },
        symptom: a.symptom,
        dtcs: a.dtcs,
      }, ctx?.apiKeyId);
      const out = { prediction_id: predictionId, diagnosis };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  },
  {
    name: "record_outcome",
    description: "Close the diagnostic loop: report what the repair actually was, keyed by the " +
      "prediction_id returned from diagnose. Feeds Fixo's calibration data.",
    inputSchema: recordOutcomeInput,
    execute: async (args, ctx) => {
      const a = args as z.infer<typeof recordOutcomeInput>;
      await recordOutcome({
        predictionId: a.prediction_id,
        confirmedDiagnosis: a.confirmed_diagnosis,
        actualCostCents: a.actual_cost_cents,
      }, ctx?.apiKeyId);
      const out = { ok: true };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  },
];
