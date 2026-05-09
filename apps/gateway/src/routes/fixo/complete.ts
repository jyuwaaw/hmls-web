// apps/gateway/src/routes/fixo/complete.ts
import { Hono } from "hono";
import { convertToModelMessages, type UIMessage } from "ai";
import { db, schema } from "@hmls/agent/db";
import { desc, eq } from "drizzle-orm";
import { refundCredits, summarizeFixoSession } from "@hmls/agent";
import { getLogger } from "@logtape/logtape";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { chargeForReport } from "../../middleware/fixo/credits.ts";
import { prependSessionEvidence } from "./lib/hydrate-media.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "complete"]);

type Variables = { auth: AuthContext };
const complete = new Hono<{ Variables: Variables }>();

complete.post("/:id/complete", async (c) => {
  const auth = c.get("auth");
  const sessionId = parseInt(c.req.param("id"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: "Invalid session ID" }, 400);
  }

  let body: { messages?: UIMessage[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  // Verify ownership before charging — never debit a user for a session
  // they can't access.
  const [session] = await db
    .select({
      id: schema.fixoSessions.id,
      userId: schema.fixoSessions.userId,
      customerId: schema.fixoSessions.customerId,
      vehicleId: schema.fixoSessions.vehicleId,
    })
    .from(schema.fixoSessions)
    .where(eq(schema.fixoSessions.id, sessionId))
    .limit(1);
  if (
    !session ||
    (session.userId !== auth.userId && session.customerId !== auth.customerId)
  ) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (!session.userId) {
    // legacy customer-only session — D2 says we don't support reports for these
    return c.json({ error: "Reports require an authenticated user" }, 403);
  }

  // Charge BEFORE generating the report (F5 fix from prior review).
  // Atomic deduction prevents the race where two concurrent /complete
  // calls both pre-check, both generate, and both bill — second user
  // gets a free report. On any failure between here and the response,
  // refundCredits below restores the balance into the topup bucket
  // (never expires).
  const charge = await chargeForReport({ auth, sessionId });
  if (charge instanceof Response) return charge;
  const chargedAmount = charge.charged;

  const startTime = Date.now();

  try {
    // Snapshot the vehicle row at this moment (D3 — historical reproducibility)
    let vehicleSnapshot: unknown = null;
    if (session.vehicleId) {
      const [v] = await db
        .select()
        .from(schema.vehicles)
        .where(eq(schema.vehicles.id, session.vehicleId))
        .limit(1);
      if (v) vehicleSnapshot = v;
    }

    // Snapshot media at this moment
    const media = await db
      .select()
      .from(schema.fixoMedia)
      .where(eq(schema.fixoMedia.sessionId, sessionId));
    const mediaSnapshot = media.map((m) => ({
      id: m.id,
      type: m.type,
      storageKey: m.storageKey,
      transcription: m.transcription,
      createdAt: m.createdAt,
    }));

    // Snapshot the most-recent estimate the agent produced for this session.
    // PDF renders tier-grouped line items from this. NULL when the agent never
    // called create_estimate (e.g. customer asked a quick question, no pricing).
    const [latestEstimate] = await db
      .select({
        id: schema.fixoEstimates.id,
        vehicleInfo: schema.fixoEstimates.vehicleInfo,
        items: schema.fixoEstimates.items,
        subtotalCents: schema.fixoEstimates.subtotalCents,
        priceRangeLowCents: schema.fixoEstimates.priceRangeLowCents,
        priceRangeHighCents: schema.fixoEstimates.priceRangeHighCents,
        shareToken: schema.fixoEstimates.shareToken,
        validDays: schema.fixoEstimates.validDays,
        expiresAt: schema.fixoEstimates.expiresAt,
        notes: schema.fixoEstimates.notes,
        createdAt: schema.fixoEstimates.createdAt,
      })
      .from(schema.fixoEstimates)
      .where(eq(schema.fixoEstimates.sessionId, sessionId))
      .orderBy(desc(schema.fixoEstimates.createdAt))
      .limit(1);
    const estimateSnapshot: unknown = latestEstimate ?? null;

    // Re-attach evidence to messages so the summarizer sees photos and codes
    const attachedMedia = await prependSessionEvidence(
      messages,
      sessionId,
      auth.userId,
      auth.customerId,
    );
    if (attachedMedia > 0) {
      logger.info("Prepended session evidence for completion", {
        sessionId,
        attachedMedia,
      });
    }

    const modelMessages = await convertToModelMessages(messages);
    const result = await summarizeFixoSession({ messages: modelMessages });

    const [report] = await db
      .insert(schema.fixoReports)
      .values({
        sessionId,
        userId: session.userId,
        result,
        vehicleSnapshot,
        mediaSnapshot,
        estimateSnapshot,
        messageCount: messages.length,
      })
      .returning();

    logger.info("Fixo report generated", {
      sessionId,
      reportId: report.id,
      duration: Date.now() - startTime,
      issueCount: result.issues.length,
      overallSeverity: result.overallSeverity,
    });

    return c.json({ reportId: report.id, sessionId, result });
  } catch (err) {
    // Refund the charge so the user isn't billed for a report we failed
    // to deliver. Refund lands in the topup bucket (never expires).
    if (chargedAmount > 0 && !auth.customerId) {
      try {
        await refundCredits({
          userId: auth.userId,
          amount: chargedAmount,
          sessionId,
          reason: "report_generation_failed",
          metadata: {
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (refundErr) {
        logger.error("Refund failed after report generation error", {
          sessionId,
          chargedAmount,
          originalError: err instanceof Error ? err.message : String(err),
          refundError: refundErr instanceof Error ? refundErr.message : String(refundErr),
        });
      }
    }
    throw err;
  }
});

export { complete };
