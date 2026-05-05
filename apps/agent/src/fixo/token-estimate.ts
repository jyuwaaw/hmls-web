import type { ModelMessage } from "ai";

const CHARS_PER_TOKEN_FALLBACK = 3.5;

/**
 * Approximate input-token count for a sequence of ModelMessages.
 *
 * Today: chars/3.5 fallback. Sufficient for compaction triggering decisions,
 * not for billing. Plan-phase follow-up will swap in a real tokenizer.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === "text") {
        chars += part.text.length;
      } else if ("output" in part && part.output) {
        chars += JSON.stringify(part.output).length;
      } else if ("input" in part && part.input) {
        chars += JSON.stringify(part.input).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_FALLBACK);
}

export function estimateTokensInString(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN_FALLBACK);
}
