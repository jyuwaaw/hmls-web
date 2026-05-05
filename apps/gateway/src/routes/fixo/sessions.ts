// apps/gateway/src/routes/fixo/sessions.ts
import { Hono } from "hono";
import { db, schema } from "@hmls/agent/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { createClient } from "@supabase/supabase-js";
import { runSummarizer } from "@hmls/agent";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "sessions"]);

type Variables = { auth: AuthContext };
const sessions = new Hono<{ Variables: Variables }>();

function ownerPredicate(auth: AuthContext) {
  return auth.customerId !== undefined
    ? or(
      eq(schema.fixoSessions.userId, auth.userId),
      eq(schema.fixoSessions.customerId, auth.customerId),
    )
    : eq(schema.fixoSessions.userId, auth.userId);
}

// POST / — create empty session
sessions.post("/", async (c) => {
  const auth = c.get("auth");
  const [session] = await db
    .insert(schema.fixoSessions)
    .values({
      userId: auth.userId,
      customerId: auth.customerId ?? null,
    })
    .returning();
  return c.json({ sessionId: session.id });
});

// GET / — list, default excludes archived
sessions.get("/", async (c) => {
  const auth = c.get("auth");
  const includeArchived = c.req.query("include_archived") === "true";

  const conditions = [ownerPredicate(auth)];
  if (!includeArchived) conditions.push(isNull(schema.fixoSessions.archivedAt));

  const rows = await db
    .select({
      id: schema.fixoSessions.id,
      title: schema.fixoSessions.title,
      vehicleId: schema.fixoSessions.vehicleId,
      lastMessageAt: schema.fixoSessions.lastMessageAt,
      createdAt: schema.fixoSessions.createdAt,
      archivedAt: schema.fixoSessions.archivedAt,
    })
    .from(schema.fixoSessions)
    .where(and(...conditions))
    .orderBy(desc(schema.fixoSessions.lastMessageAt));

  return c.json({ sessions: rows });
});

// GET /:id — full detail
sessions.get("/:id", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const [session] = await db
    .select()
    .from(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .limit(1);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const media = await db
    .select()
    .from(schema.fixoMedia)
    .where(eq(schema.fixoMedia.sessionId, id));
  const codes = await db
    .select()
    .from(schema.obdCodes)
    .where(eq(schema.obdCodes.sessionId, id));

  return c.json({ session, media, codes });
});

// PATCH /:id — rename / archive / unarchive
const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  archivedAt: z.union([z.string().datetime(), z.null()]).optional(),
});

sessions.patch("/:id", zValidator("json", patchSchema), async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const body = c.req.valid("json");
  const update: Partial<typeof schema.fixoSessions.$inferInsert> = {};
  if (body.title !== undefined) {
    update.title = body.title;
    update.titleIsUserSet = true;
  }
  if (body.archivedAt !== undefined) {
    update.archivedAt = body.archivedAt === null ? null : new Date(body.archivedAt);
  }
  if (Object.keys(update).length === 0) return c.json({ error: "nothing to update" }, 400);

  const [updated] = await db
    .update(schema.fixoSessions)
    .set(update)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ session: updated });
});

// DELETE /:id — hard delete + storage cleanup
sessions.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  // 1. collect storage keys before cascade wipes them
  const mediaRows = await db
    .select({ storageKey: schema.fixoMedia.storageKey })
    .from(schema.fixoMedia)
    .where(eq(schema.fixoMedia.sessionId, id));

  // 2. cascade delete via session row
  const deleted = await db
    .delete(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .returning({ id: schema.fixoSessions.id });
  if (deleted.length === 0) return c.json({ error: "Session not found" }, 404);

  // 3. best-effort storage cleanup
  if (mediaRows.length > 0) {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (url && serviceKey) {
      const supabase = createClient(url, serviceKey);
      const keys = mediaRows.map((m) => m.storageKey);
      const bucket = Deno.env.get("FIXO_MEDIA_BUCKET") ?? "fixo-media";
      const { error } = await supabase.storage.from(bucket).remove(keys);
      if (error) {
        logger.warn("Storage cleanup failed (non-blocking)", {
          sessionId: id,
          keyCount: keys.length,
          error: error.message,
        });
      }
    }
  }
  return c.json({ deleted: true });
});

// GET /:id/reports — list report snapshots for this session
sessions.get("/:id/reports", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const [session] = await db
    .select({ id: schema.fixoSessions.id })
    .from(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .limit(1);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const reports = await db
    .select({
      id: schema.fixoReports.id,
      messageCount: schema.fixoReports.messageCount,
      generatedAt: schema.fixoReports.generatedAt,
      severity: sql<string | null>`${schema.fixoReports.result}->>'overallSeverity'`,
      summary: sql<string | null>`${schema.fixoReports.result}->>'summary'`,
    })
    .from(schema.fixoReports)
    .where(eq(schema.fixoReports.sessionId, id))
    .orderBy(desc(schema.fixoReports.generatedAt));
  return c.json({ reports });
});

// POST /:id/compact — manual context compaction
sessions.post("/:id/compact", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        messages: schema.fixoSessions.messages,
        summary: schema.fixoSessions.summary,
        lastSummarizedMessageId: schema.fixoSessions.lastSummarizedMessageId,
        userId: schema.fixoSessions.userId,
        customerId: schema.fixoSessions.customerId,
      })
      .from(schema.fixoSessions)
      .where(eq(schema.fixoSessions.id, id))
      .for("update")
      .limit(1);

    if (
      !session ||
      (session.userId !== auth.userId && session.customerId !== auth.customerId)
    ) {
      return { kind: "not_found" as const };
    }

    const allMessages = (session.messages ?? []) as Array<{ id: string }>;
    if (allMessages.length === 0) {
      return { kind: "empty" as const };
    }

    const KEEP_RECENT_COUNT = 12;
    const cursorIndex = session.lastSummarizedMessageId
      ? allMessages.findIndex((m) => m.id === session.lastSummarizedMessageId) + 1
      : 0;
    const unsummarized = allMessages.slice(Math.max(0, cursorIndex));
    const messagesToFold = unsummarized.slice(
      0,
      Math.max(0, unsummarized.length - KEEP_RECENT_COUNT),
    );
    if (messagesToFold.length === 0) {
      return { kind: "noop" as const, summary: session.summary };
    }

    const newSummary = await runSummarizer({
      previousSummary: session.summary ?? null,
      // deno-lint-ignore no-explicit-any
      messagesToFold: messagesToFold as any,
    });

    await tx
      .update(schema.fixoSessions)
      .set({
        summary: newSummary,
        lastSummarizedMessageId: messagesToFold[messagesToFold.length - 1].id,
      })
      .where(eq(schema.fixoSessions.id, id));

    return {
      kind: "ok" as const,
      summary: newSummary,
      messagesFolded: messagesToFold.length,
    };
  });

  if (result.kind === "not_found") {
    return c.json({ error: "Session not found" }, 404);
  }
  if (result.kind === "empty") {
    return c.json({ error: "session has no messages to compact" }, 400);
  }
  if (result.kind === "noop") {
    return c.json({ message: "nothing to compact", summary: result.summary });
  }
  return c.json({
    summary: result.summary,
    messagesFolded: result.messagesFolded,
  });
});

export { sessions };
