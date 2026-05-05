import { Hono } from "hono";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { type InputType, uploadMedia } from "@hmls/agent";
import { processCredits } from "../../middleware/fixo/credits.ts";
import { requireMediaTier } from "../../middleware/fixo/tier.ts";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

type Variables = { auth: AuthContext };

const input = new Hono<{ Variables: Variables }>();

/** Verify a client-declared contentType is plausible for the requested input
 * type. Defense-in-depth alongside the bucket-side allowed_mime_types config. */
export function contentTypeMatches(
  type: "photo" | "audio" | "video",
  contentType: string,
): boolean {
  if (type === "photo") return contentType.startsWith("image/");
  if (type === "audio") return contentType.startsWith("audio/");
  if (type === "video") return contentType.startsWith("video/");
  return false;
}

// POST /sessions/:id/input - Process input (non-streaming)
input.post("/:id/input", async (c) => {
  const auth = c.get("auth");
  const sessionId = parseInt(c.req.param("id"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: "Invalid session id" }, 400);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { type, content, filename, contentType, durationSeconds, spectrogramBase64 } = body;

  // Validate input type up front so unit tests don't need DB access. Text-only
  // input goes through /task chat directly (not this endpoint) so 'text' is no
  // longer accepted here.
  const validTypes = ["obd", "photo", "audio", "video"];
  if (!validTypes.includes(type)) {
    return c.json({ error: "Invalid input type" }, 400);
  }
  if (type === "obd" && (typeof content !== "string" || !content.trim())) {
    return c.json({ error: "OBD code is required" }, 400);
  }
  if (
    (type === "photo" || type === "audio" || type === "video") &&
    (typeof content !== "string" || !content)
  ) {
    return c.json({ error: "Media content is required" }, 400);
  }
  if (
    (type === "photo" || type === "audio" || type === "video") &&
    typeof contentType === "string" &&
    !contentTypeMatches(type, contentType)
  ) {
    return c.json(
      {
        error: `contentType ${contentType} does not match input type ${type}`,
      },
      400,
    );
  }

  const [session] = await db
    .select()
    .from(schema.fixoSessions)
    .where(eq(schema.fixoSessions.id, sessionId))
    .limit(1);

  if (
    !session ||
    (session.userId !== auth.userId && session.customerId !== auth.customerId)
  ) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Check free tier limits for SaaS users (non-legacy)
  if (!auth.customerId) {
    const tierBlock = requireMediaTier(auth);
    if (tierBlock) return tierBlock;
  }

  // Check and deduct credits (only for legacy customers with Stripe)
  let creditCharged = 0;
  if (auth.stripeCustomerId && auth.customerId) {
    const creditResult = await processCredits(
      auth.stripeCustomerId,
      type as InputType,
      sessionId,
      durationSeconds,
    );
    if (creditResult instanceof Response) {
      return creditResult;
    }
    creditCharged = creditResult.charged;
  }

  // Bump session credit counter.
  await db
    .update(schema.fixoSessions)
    .set({ creditsCharged: session.creditsCharged + creditCharged })
    .where(eq(schema.fixoSessions.id, sessionId));

  // Persist input. The chat agent on /task hydrates fixoMedia rows for the
  // session into FileUIParts when streaming a reply, so this endpoint stays
  // pure storage + bookkeeping (no LLM call here).
  let mediaId: number | null = null;
  let spectrogramMediaId: number | null = null;

  if (type === "obd") {
    await db.insert(schema.obdCodes).values({
      sessionId,
      code: content,
      source: "manual",
    });
  } else if (type === "photo" || type === "audio" || type === "video") {
    const binaryData = Uint8Array.from(
      atob(content),
      (ch) => ch.charCodeAt(0),
    );
    const uploadResult = await uploadMedia(
      binaryData,
      filename,
      contentType,
      String(sessionId),
    );

    const [mediaRow] = await db.insert(schema.fixoMedia).values({
      sessionId,
      type,
      storageKey: uploadResult.key,
      creditCost: creditCharged,
      processingStatus: "complete",
      metadata: { filename, contentType, durationSeconds },
    }).returning({ id: schema.fixoMedia.id });
    mediaId = mediaRow.id;

    // Audio: client also generates a spectrogram PNG. Persist it as its own
    // fixoMedia row so the chat agent can see it as a FileUIPart on the next
    // /task turn — Gemini analyzes the spectrogram inline (the dedicated
    // analyzeAudioNoise tool was removed; the model has the image directly).
    if (type === "audio" && spectrogramBase64) {
      const spectrogramData = Uint8Array.from(
        atob(spectrogramBase64),
        (ch) => ch.charCodeAt(0),
      );
      const spectrogramUpload = await uploadMedia(
        spectrogramData,
        `spectrogram-${filename}.png`,
        "image/png",
        String(sessionId),
      );
      const [specRow] = await db.insert(schema.fixoMedia).values({
        sessionId,
        type: "photo",
        storageKey: spectrogramUpload.key,
        creditCost: 0,
        processingStatus: "complete",
        metadata: {
          filename: `spectrogram-${filename}.png`,
          contentType: "image/png",
          spectrogramFor: mediaId,
        },
      }).returning({ id: schema.fixoMedia.id });
      spectrogramMediaId = specRow.id;
    }
  }

  return c.json({
    sessionId,
    mediaId,
    spectrogramMediaId,
    creditsCharged: creditCharged,
    sessionCreditsTotal: session.creditsCharged + creditCharged,
  });
});

export { input };
