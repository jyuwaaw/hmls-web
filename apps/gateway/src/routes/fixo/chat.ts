// apps/gateway/src/routes/fixo/chat.ts
import { Hono } from "hono";
import { convertToModelMessages, generateText, type UIMessage } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { buildAgentContext, runFixoAgent } from "@hmls/agent";
import { requireTextQuota } from "../../middleware/fixo/tier.ts";
import { getLogger } from "@logtape/logtape";
import { db, schema } from "@hmls/agent/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { hydrateSessionMedia } from "./lib/hydrate-media.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "chat"]);

type Variables = { auth: AuthContext };

const chat = new Hono<{ Variables: Variables }>();

chat.post("/", async (c) => {
  const auth = c.get("auth");

  let body: { messages?: UIMessage[]; sessionId?: number | string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  const parsedSessionId = typeof body.sessionId === "string"
    ? parseInt(body.sessionId)
    : typeof body.sessionId === "number"
    ? body.sessionId
    : null;

  if (parsedSessionId === null || !Number.isInteger(parsedSessionId)) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (!latestUserMessage) {
    return c.json({ error: "no user message in payload" }, 400);
  }

  // 1. Idempotent counter insert. ON CONFLICT DO NOTHING means client retries
  //    do not double-count the same UIMessage.id.
  const [inserted] = await db
    .insert(schema.fixoMessageEvents)
    .values({
      userMessageId: latestUserMessage.id,
      userId: auth.userId,
      sessionId: parsedSessionId,
      month: monthDate(),
    })
    .onConflictDoNothing({ target: schema.fixoMessageEvents.userMessageId })
    .returning({ userMessageId: schema.fixoMessageEvents.userMessageId });
  const isNewMessage = !!inserted;

  // 2. Quota check ONLY for new messages — replays/retries skip the gate.
  if (isNewMessage) {
    const tierBlock = await requireTextQuota(auth);
    if (tierBlock) {
      // Roll back the insert so the user isn't charged a quota slot they
      // can't use.
      await db
        .delete(schema.fixoMessageEvents)
        .where(eq(schema.fixoMessageEvents.userMessageId, latestUserMessage.id));
      return tierBlock;
    }
  }

  const startTime = Date.now();
  const messageCount = messages.length;
  logger.info("Request received", {
    userId: auth.userId,
    messageCount,
    sessionId: parsedSessionId,
    isNewMessage,
  });

  try {
    const originalMessages: UIMessage[] = structuredClone(messages);

    const attachedMedia = await hydrateSessionMedia(
      messages,
      parsedSessionId,
      auth.userId,
      auth.customerId,
    );
    if (attachedMedia > 0) {
      logger.info("Hydrated session media", { sessionId: parsedSessionId, attachedMedia });
    }

    const latestMessages = await convertToModelMessages(messages);
    const { systemPrompt, modelMessages } = await buildAgentContext({
      sessionId: parsedSessionId,
      latestMessages,
      uiMessages: messages,
    });

    const result = runFixoAgent({
      messages: modelMessages,
      systemPrompt,
      userId: auth.userId,
      fixoSessionId: parsedSessionId,
    });

    const response = result.toUIMessageStreamResponse({
      originalMessages,
      onFinish: ({ messages: finalMessages }) => {
        // Persist transcript + bump last_message_at + maybe trigger title gen.
        // All fire-and-forget — failure logs but does not delay stream close.
        db
          .update(schema.fixoSessions)
          .set({
            messages: finalMessages,
            lastMessageAt: new Date(),
          })
          .where(
            and(
              eq(schema.fixoSessions.id, parsedSessionId),
              ownerPredicate(auth),
            ),
          )
          .catch((err: unknown) => {
            logger.warn("Failed to persist transcript", {
              sessionId: parsedSessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

        maybeGenerateTitle(parsedSessionId, finalMessages, auth);
      },
    });

    logger.info("Request finished", {
      userId: auth.userId,
      messageCount,
      duration: Date.now() - startTime,
      attachedMedia,
    });
    return response;
  } catch (error) {
    logger.error("Agent failed", {
      userId: auth.userId,
      messageCount,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

function monthDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function ownerPredicate(auth: AuthContext) {
  return auth.customerId !== undefined
    ? sql`(${schema.fixoSessions.userId} = ${auth.userId} OR ${schema.fixoSessions.customerId} = ${auth.customerId})`
    : eq(schema.fixoSessions.userId, auth.userId);
}

/**
 * Fire-and-forget title generator. Triggered after the FIRST assistant turn.
 * Race-safe via WHERE clause: title IS NULL AND title_is_user_set = false.
 */
function maybeGenerateTitle(
  sessionId: number,
  finalMessages: UIMessage[],
  auth: AuthContext,
): void {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) return;

  const userMsg = finalMessages.find((m) => m.role === "user");
  const assistantMsg = finalMessages.find((m) => m.role === "assistant");
  if (!userMsg || !assistantMsg) return;

  const preview = (userMsg.parts.find((p) => p.type === "text") as { text?: string } | undefined)
    ?.text;
  if (!preview) return;

  const google = createGoogleGenerativeAI({ apiKey });
  generateText({
    model: google("gemini-2.5-flash"),
    prompt:
      `Summarize this car-diagnosis conversation as a 4-6 word title. No quotes, no period.\n\nConversation:\n${
        preview.slice(0, 500)
      }`,
  })
    .then(({ text }) =>
      db.update(schema.fixoSessions)
        .set({ title: text.trim() })
        .where(
          and(
            eq(schema.fixoSessions.id, sessionId),
            isNull(schema.fixoSessions.title),
            eq(schema.fixoSessions.titleIsUserSet, false),
            ownerPredicate(auth),
          ),
        )
    )
    .catch((err) => logger.warn("title generation failed", { sessionId, err }));
}

export { chat };
