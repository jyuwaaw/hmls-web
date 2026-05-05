// apps/gateway/src/routes/fixo/complete.ts
import { Hono } from "hono";
import { convertToModelMessages, type UIMessage } from "ai";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { summarizeFixoSession } from "@hmls/agent";
import { getLogger } from "@logtape/logtape";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { requireReportQuota } from "../../middleware/fixo/tier.ts";
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

  const tierBlock = await requireReportQuota(auth);
  if (tierBlock) return tierBlock;

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

  const startTime = Date.now();

  // Verify ownership and pull vehicle for snapshot
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

  // Re-attach evidence to messages so the summarizer sees photos and codes
  const attachedMedia = await prependSessionEvidence(
    messages,
    sessionId,
    auth.userId,
    auth.customerId,
  );
  if (attachedMedia > 0) {
    logger.info("Prepended session evidence for completion", { sessionId, attachedMedia });
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
});

export { complete };
