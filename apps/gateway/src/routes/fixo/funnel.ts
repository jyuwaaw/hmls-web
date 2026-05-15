// Public funnel-event beacon endpoint for fixo推广 channel attribution.
//
// Today: POST /track only. Callers fetch from the browser (SEO landing
// pages fire a fetch() on mount; TikTok bio links land on fixo.ink which
// fires fetch() during page render). GET-redirect handlers (for email
// CTAs that want to capture the click before redirecting to fixo.ink)
// are NOT implemented yet — Lane D will add `GET /track?event=...&to=...`
// when the HMLS rejection email integration ships.
//
// Public on purpose — no auth required because SEO hits happen before
// sign-in. The endpoint validates event_name and channel against a
// strict regex (lowercase alphanumeric + underscore), caps metadata at
// 4KB, and ignores any user_id the client supplies (server-side auth
// context wins; otherwise userId stays null and gets back-filled later
// by joining on the most recent fingerprint or device cookie).

import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "@logtape/logtape";
import { insertFunnelEvent } from "@hmls/agent";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { authenticateRequest } from "../../middleware/fixo/auth.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "funnel"]);

const trackSchema = z.object({
  event_name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "lowercase alphanumeric + underscore only"),
  channel: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/, "lowercase alphanumeric + underscore only"),
  channel_detail: z.string().max(128).optional(),
  session_id: z.number().int().positive().optional(),
  // Limit metadata size; jsonb column on Postgres has practical limits and
  // we don't want clients sending megabytes.
  metadata: z.record(z.string(), z.unknown()).optional()
    .refine((m) => !m || JSON.stringify(m).length < 4096, {
      message: "metadata too large (max 4KB serialized)",
    }),
});

export const funnel = new Hono<{ Variables: { auth?: AuthContext } }>();

funnel.post("/track", async (c) => {
  // Optional auth: if the request carries a valid session, attribute the
  // event to that user. Otherwise it's an anonymous beacon.
  let userId: string | null = null;
  const authResult = await authenticateRequest(c.req.raw);
  if (!(authResult instanceof Response)) {
    userId = authResult.userId;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = trackSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("funnel track validation failed", {
      issues: parsed.error.issues,
    });
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  // Strict mode: /funnel/track exists to write the event. Surface DB
  // failures (connection pool exhausted, stale FK, etc.) so the client
  // can decide to retry. recordFunnelEvent's swallowed-error mode is
  // for backend insert points where the funnel write is a side effect
  // of a more important request — not the case here.
  try {
    await insertFunnelEvent({
      eventName: parsed.data.event_name,
      channel: parsed.data.channel,
      channelDetail: parsed.data.channel_detail,
      userId,
      sessionId: parsed.data.session_id,
      metadata: parsed.data.metadata,
    });
  } catch (err) {
    logger.error("funnel event persist failed", {
      eventName: parsed.data.event_name,
      channel: parsed.data.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: "Failed to record event", code: "funnel_persist_failed" },
      502,
    );
  }

  return c.json({ recorded: true }, 202);
});
