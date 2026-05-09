import type { ModelMessage, UIMessage } from "ai";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { estimateTokens, estimateTokensInString } from "./token-estimate.ts";
import { runSummarizer } from "./summarizer.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import type { DiagnosticState } from "@hmls/shared/db/schema";

/** Format the structured diagnostic state for injection into the system prompt.
 *  Returns null when the state has no meaningful content (empty object or all
 *  fields blank), so the prompt skips the section entirely. */
function formatDiagnosticState(state: DiagnosticState | null | undefined): string | null {
  if (!state) return null;
  const hasContent = Object.values(state).some((v) => {
    if (v === undefined || v === null) return false;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  });
  if (!hasContent) return null;
  return JSON.stringify(state, null, 2);
}

const logger = getLogger(["hmls", "agent", "fixo", "context"]);

export const COMPACT_THRESHOLD = 30_000;
export const KEEP_RECENT_COUNT = 12;

export interface BuildAgentContextOptions {
  sessionId: number;
  latestMessages: ModelMessage[];
  uiMessages: UIMessage[];
}

export interface AgentContext {
  systemPrompt: string;
  modelMessages: ModelMessage[];
}

/**
 * Locate the index AFTER the message whose id matches `markerId`.
 * Returns 0 when markerId is null or the marker isn't found in the array.
 */
export function findCursorIndex(uiMessages: UIMessage[], markerId: string | null): number {
  if (markerId === null) return 0;
  for (let i = 0; i < uiMessages.length; i++) {
    if (uiMessages[i].id === markerId) return i + 1;
  }
  // Marker not found — treat as fresh start. Refolding from scratch is safer
  // than skipping unknowable content.
  logger.warn("summary cursor marker not found in current message array", {
    markerId,
    messageCount: uiMessages.length,
  });
  return 0;
}

/**
 * Build agent context (systemPrompt + windowed modelMessages) for a Fixo turn.
 *
 * The whole body runs inside one transaction with `SELECT ... FOR UPDATE` on
 * the session row. This serializes concurrent /task or /compact callers so
 * `summary` and `last_summarized_message_id` cannot drift apart.
 */
export async function buildAgentContext(
  opts: BuildAgentContextOptions,
): Promise<AgentContext> {
  return await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        summary: schema.fixoSessions.summary,
        lastSummarizedMessageId: schema.fixoSessions.lastSummarizedMessageId,
        diagnosticState: schema.fixoSessions.diagnosticState,
      })
      .from(schema.fixoSessions)
      .where(eq(schema.fixoSessions.id, opts.sessionId))
      .for("update")
      .limit(1);

    if (!session) {
      // Session disappeared mid-flight (delete race?). Fall back to no-summary.
      return {
        systemPrompt: SYSTEM_PROMPT,
        modelMessages: opts.latestMessages.slice(-KEEP_RECENT_COUNT),
      };
    }

    const cursorIndex = findCursorIndex(opts.uiMessages, session.lastSummarizedMessageId);
    const unsummarized = opts.uiMessages.slice(cursorIndex);

    const summaryTokens = estimateTokensInString(session.summary);
    const unsummarizedTokens = estimateTokens(opts.latestMessages.slice(cursorIndex));
    const estimatedTotal = summaryTokens + unsummarizedTokens;

    let summary: string | null = session.summary ?? null;
    const shouldSummarize = estimatedTotal > COMPACT_THRESHOLD ||
      unsummarized.length > KEEP_RECENT_COUNT * 2;

    if (shouldSummarize) {
      const foldEnd = unsummarized.length - KEEP_RECENT_COUNT;
      const messagesToFold = unsummarized.slice(0, Math.max(0, foldEnd));
      if (messagesToFold.length > 0) {
        const before = estimatedTotal;
        try {
          summary = await runSummarizer({
            previousSummary: summary,
            messagesToFold,
          });
          const lastFolded = messagesToFold[messagesToFold.length - 1];
          await tx
            .update(schema.fixoSessions)
            .set({
              summary,
              lastSummarizedMessageId: lastFolded.id,
            })
            .where(eq(schema.fixoSessions.id, opts.sessionId));

          const after = estimateTokensInString(summary) +
            estimateTokens(opts.latestMessages.slice(-KEEP_RECENT_COUNT));
          logger.info("fixo.compact.triggered", {
            sessionId: opts.sessionId,
            messagesFolded: messagesToFold.length,
            beforeTokens: before,
            afterTokens: after,
          });
        } catch (err) {
          // Summarizer failure: log + fall through with un-summarized context
          // for this turn. Next turn retries.
          logger.warn("Summarizer failed; falling back to un-windowed context", {
            sessionId: opts.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const formattedState = formatDiagnosticState(session.diagnosticState);

    const sections: string[] = [SYSTEM_PROMPT];
    if (summary) {
      sections.push(`## Known facts so far\n${summary}`);
    }
    if (formattedState) {
      sections.push(
        `## Current diagnostic state\n` +
          `(structured memory, mutate via update_diagnostic_state)\n` +
          `\`\`\`json\n${formattedState}\n\`\`\``,
      );
    }
    const systemPrompt = sections.join("\n\n");

    return {
      systemPrompt,
      modelMessages: opts.latestMessages.slice(-KEEP_RECENT_COUNT),
    };
  });
}
