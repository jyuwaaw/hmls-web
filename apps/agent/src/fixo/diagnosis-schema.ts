import { z } from "zod";

export const structuredDiagnosisSchema = z.object({
  candidate_systems: z.array(z.object({
    system: z.string().describe("e.g. 'brakes', 'fuel', 'ignition', 'cooling'"),
    // NOTE: keep this z.number().int().min().max(), NOT a z.union of literals.
    // Gemini's function-calling rejects numeric-literal `any_of`/enum schemas
    // (INVALID_ARGUMENT — it wants string enums), which 500s /v1/diagnose.
    confidence: z.number().int().min(0).max(3).describe("0=ruled-out,1=low,2=medium,3=high"),
    reasons: z.array(z.string()),
  })).describe("Ranked suspect systems."),
  likely_root_cause: z.string().optional()
    .describe("Single most-likely cause — set ONLY when evidence supports one answer."),
  recommended_tests: z.array(z.string()).describe("Pinpoint tests to confirm, cheapest-first."),
  safety_flags: z.array(z.string()).describe("Anything unsafe to drive with. Empty if none."),
  to_confirm: z.array(z.string())
    .describe("Questions the shop should confirm with the owner / on-site to narrow it down."),
  narrative: z.string().describe("Short plain-language summary for the shop."),
});

export type StructuredDiagnosis = z.infer<typeof structuredDiagnosisSchema>;
