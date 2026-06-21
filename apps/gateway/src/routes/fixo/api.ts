// Fixo public API (v1) — the diagnostic brain over REST. Key-gated (see the
// api-key middleware). One symptom in → the agent's diagnosis + estimate out.
// Wraps the proven full agent via runFixoOnce (single-shot, read-only).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { runFixoOnce } from "@hmls/agent";

const diagnoseInput = z.object({
  vehicle: z.object({
    year: z.union([z.number(), z.string()]),
    make: z.string().min(1),
    model: z.string().min(1),
  }),
  symptom: z.string().min(1, "symptom is required"),
  dtcs: z.array(z.string()).optional(),
});

export const fixoApi = new Hono();

// POST /v1/diagnose — diagnosis + estimate for a vehicle + symptom.
fixoApi.post("/diagnose", zValidator("json", diagnoseInput), async (c) => {
  const body = c.req.valid("json");
  const result = await runFixoOnce(body);
  return c.json(result);
});
