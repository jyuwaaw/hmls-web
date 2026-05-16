// Public funnel-event beacon endpoint for fixo推广 channel attribution.
//
// Two endpoints:
//
//   POST /track — JSON beacon. Used by client-side fetch() from SEO
//     landing pages and the fixo.ink web app. Returns 202 on success,
//     502 on persist failure so the client can retry.
//
//   GET /track — redirect. Used by HMLS rejection emails and any other
//     plain <a href> CTAs that want to capture the click server-side
//     before redirecting the browser onward. Records the event then
//     302s to `?to=<allowlisted-url>`. Open-redirect protected — `to`
//     must match the allowlist (fixo.ink, fixo.hmls.autos, hmls.autos,
//     or localhost in dev). Off-allowlist `to` returns 400 instead of
//     redirecting, so this endpoint can't be used as a phishing relay.
//
// Public on purpose — no auth required because SEO and email-CTA hits
// happen before sign-in. The endpoint validates event_name and channel
// against a strict regex (lowercase alphanumeric + underscore), caps
// metadata at 4KB, and ignores any user_id the client supplies
// (server-side auth context wins; otherwise userId stays null and gets
// back-filled later by joining on the most recent fingerprint or
// device cookie).

import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "@logtape/logtape";
import { insertFunnelEvent, recordFunnelEvent } from "@hmls/agent";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { authenticateRequest } from "../../middleware/fixo/auth.ts";

const REDIRECT_ALLOWED_HOSTS = new Set([
  "fixo.ink",
  "www.fixo.ink",
  "fixo.hmls.autos",
  "hmls.autos",
  "www.hmls.autos",
  "localhost",
  "fixo.localhost",
]);

function isRedirectAllowed(rawTo: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawTo);
  } catch {
    return { ok: false, reason: "to_must_be_absolute_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "to_protocol_not_http" };
  }
  if (!REDIRECT_ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, reason: "to_host_not_allowlisted" };
  }
  return { ok: true, url };
}

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

// GET /funnel/track?event=&channel=&channel_detail=&to=
// Email-CTA-friendly redirect. Records the event, then 302s to `to`.
// Open-redirect protected via REDIRECT_ALLOWED_HOSTS allowlist.
//
// Failure modes:
//   - Missing/invalid event or channel → 400 (does NOT redirect — we don't
//     want a malformed link to silently work as a generic redirect relay)
//   - `to` missing or not allowlisted → 400
//   - DB insert fails → log + redirect anyway. Different from POST: a
//     user clicking an email link in their inbox should NOT see an
//     error page just because our DB is down. Lost event > lost user.
const getQuerySchema = z.object({
  event: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/),
  channel: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/),
  channel_detail: z.string().max(128).optional(),
  to: z.string().url(),
});

funnel.get("/track", async (c) => {
  let userId: string | null = null;
  const authResult = await authenticateRequest(c.req.raw);
  if (!(authResult instanceof Response)) {
    userId = authResult.userId;
  }

  const parsed = getQuerySchema.safeParse({
    event: c.req.query("event"),
    channel: c.req.query("channel"),
    channel_detail: c.req.query("channel_detail") ?? undefined,
    to: c.req.query("to"),
  });
  if (!parsed.success) {
    logger.warn("funnel GET validation failed", { issues: parsed.error.issues });
    return c.json({ error: "Invalid query params", issues: parsed.error.issues }, 400);
  }

  const allow = isRedirectAllowed(parsed.data.to);
  if (!allow.ok) {
    logger.warn("funnel GET refused redirect", {
      to: parsed.data.to,
      reason: allow.reason,
    });
    return c.json({ error: "Redirect target not allowed", reason: allow.reason }, 400);
  }

  // Use recordFunnelEvent (swallows errors) — a transient DB blip must
  // not break the click-through for the user.
  await recordFunnelEvent({
    eventName: parsed.data.event,
    channel: parsed.data.channel,
    channelDetail: parsed.data.channel_detail,
    userId,
    metadata: {
      via: "GET",
      ua: c.req.header("user-agent") ?? null,
    },
  });

  return c.redirect(allow.url.toString(), 302);
});
