// Funnel event recording helper for fixo推广 channel attribution.
//
// Backs the kill criteria SQL queries described in
// ~/.gstack/projects/hmls-autos-hmls/ceo-plans/2026-05-14-fixo-speed-wedge-30day.md.
// Writes to the fixo_funnel_events table created by migration 0025.
//
// Design notes:
// - Fire-and-forget at call sites: a funnel write must never block or fail
//   the originating request (Stripe webhook, chat turn, etc.). The helper
//   catches and logs internally; callers should not await it on the
//   critical path beyond what is necessary for ordering.
// - event_name and channel are free-form text so the推广 wedge can swap
//   over the next 90 days without a migration. See migration 0025 comments.
// - user_id and session_id are nullable: SEO page views and email-CTA
//   clicks land before signin, so we record without a user_id and back-fill
//   later via the same fingerprint cookie if/when the user authenticates.

import { getLogger } from "@logtape/logtape";
import { db } from "../db/client.ts";
import * as schema from "@hmls/shared/db/schema";

const logger = getLogger(["hmls", "agent", "funnel"]);

export interface FunnelEventInput {
  /**
   * Stable event identifier. Examples used in the CEO plan:
   * - "seo_page_view"
   * - "hmls_rejection_click"
   * - "oauth_login"
   * - "first_diagnosis"
   * - "paid_top_up"
   * - "tiktok_click"
   * - "reddit_click"
   */
  eventName: string;
  /**
   * Top-level channel bucket. CEO plan tracks: seo | reddit | tiktok |
   * hmls | direct. New channels can be added without schema changes.
   */
  channel: string;
  /**
   * Optional disambiguator within a channel (e.g. OBD code for SEO,
   * creator handle for TikTok, rejection_type for HMLS).
   */
  channelDetail?: string | null;
  /** Set when the event occurs post-signin or back-fills a known user. */
  userId?: string | null;
  /** Set when the event ties to an active fixo diagnostic session. */
  sessionId?: number | null;
  /**
   * Free-form additional structured data. Examples: UTM params, dollar
   * amount of a top-up, stripe event id, page path.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert a funnel event. THROWS on DB failure — use this when the
 * funnel write IS the operation (e.g., the public POST /funnel/track
 * beacon, where the client needs to know whether to retry).
 *
 * For backend insert points where the funnel write is a side effect of
 * a more important request (Stripe webhook, chat turn), use
 * `recordFunnelEvent` instead — it logs and swallows errors so the
 * originating request continues uninterrupted.
 *
 * Idempotency is intentionally NOT enforced here. Analytical
 * deduplication happens at query time via DISTINCT on (user_id,
 * event_name, time-bucket) when needed. Call sites that need
 * idempotency (e.g., Stripe webhook retries) gate the call themselves
 * with their own dedup key.
 */
export async function insertFunnelEvent(input: FunnelEventInput): Promise<void> {
  await db.insert(schema.funnelEvents).values({
    eventName: input.eventName,
    channel: input.channel,
    channelDetail: input.channelDetail ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    metadata: input.metadata ?? null,
  });
}

/**
 * Record a funnel event from a backend insert point. Never throws —
 * failures are logged but the originating request continues. Use this
 * inside Stripe webhooks, chat handlers, or any other path where the
 * funnel write is a side effect that must never fail the parent
 * request.
 *
 * If the funnel write IS the operation (public beacon endpoint), use
 * `insertFunnelEvent` instead — it surfaces errors to the client.
 */
export async function recordFunnelEvent(input: FunnelEventInput): Promise<void> {
  try {
    await insertFunnelEvent(input);
  } catch (err) {
    logger.error("funnel event insert failed", {
      eventName: input.eventName,
      channel: input.channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
