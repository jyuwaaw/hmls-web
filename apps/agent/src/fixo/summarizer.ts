import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getLogger } from "@logtape/logtape";
import type { UIMessage } from "ai";

const logger = getLogger(["hmls", "agent", "fixo", "summarizer"]);

export const SUMMARIZER_MODEL = "gemini-2.5-flash";

const SUMMARIZER_SYSTEM = `You are a context compactor for Fixo, a car-diagnosis assistant. Fold the
following conversation into the existing "Known facts" memo. Preserve:

1. Vehicle (year/make/model/mileage/VIN if mentioned)
2. Symptoms (what the user described, when, conditions)
3. OBD codes seen (with their resolved meaning if looked up)
4. Tools called and their key outputs (labor times, parts, severity)
5. Hypotheses confirmed or ruled out
6. Pending questions the assistant asked but user hasn't answered
7. Uploaded evidence — for each photo / audio / video the user uploaded,
   keep a one-sentence factual description of what it showed (e.g. "photo
   of dashboard with check-engine light + ABS light on", "20-second engine
   recording with rhythmic knocking at idle"). Include the media id so
   later turns can re-reference. Do NOT drop these — they are why the
   diagnosis exists.

Drop:
- Greetings, filler, restated questions
- Tool call mechanics (just keep the answer)
- Verbatim signed-URL strings (re-hydrated separately every turn)

Output: one terse markdown bullet list under 800 tokens. No prose.`;

export interface RunSummarizerOptions {
  previousSummary: string | null;
  messagesToFold: UIMessage[];
}

export async function runSummarizer(
  opts: RunSummarizerOptions,
): Promise<string> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY required for summarizer");

  const transcript = serializeForSummarizer(opts.messagesToFold);
  const prompt = opts.previousSummary
    ? `EXISTING MEMO:\n${opts.previousSummary}\n\nNEW CONVERSATION TO FOLD IN:\n${transcript}`
    : `CONVERSATION:\n${transcript}`;

  const google = createGoogleGenerativeAI({ apiKey });
  const start = Date.now();
  const { text } = await generateText({
    model: google(SUMMARIZER_MODEL),
    system: SUMMARIZER_SYSTEM,
    prompt,
  });
  logger.info("Summarizer complete", {
    durationMs: Date.now() - start,
    foldedCount: opts.messagesToFold.length,
    outputLen: text.length,
  });
  return text.trim();
}

/**
 * Render UIMessages as plain-text-ish input for the summarizer. Includes
 * media references with their ids so the summarizer can keep pointers.
 */
function serializeForSummarizer(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const prefix = m.role === "user"
      ? "USER"
      : m.role === "assistant"
      ? "ASSISTANT"
      : m.role.toUpperCase();
    for (const part of m.parts) {
      if (part.type === "text") {
        lines.push(`${prefix}: ${part.text}`);
      } else if (part.type === "file") {
        const mediaType = (part as { mediaType?: string }).mediaType ?? "file";
        const id = (part as { id?: string }).id ?? "(no id)";
        lines.push(`${prefix}: [uploaded ${mediaType}, media_id=${id}]`);
      } else if ("toolName" in part) {
        const tn = (part as { toolName?: string }).toolName;
        const output = (part as { output?: unknown }).output;
        if (output !== undefined) {
          lines.push(`TOOL[${tn}]: ${JSON.stringify(output).slice(0, 500)}`);
        }
      }
    }
  }
  return lines.join("\n");
}
