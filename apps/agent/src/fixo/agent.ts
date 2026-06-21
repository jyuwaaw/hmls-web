import { hasToolCall, type ModelMessage, stepCountIs, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getLogger } from "@logtape/logtape";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { extractVideoFramesTool } from "./tools/extractVideoFrames.ts";
import { lookupObdCodeTool } from "./tools/lookupObdCode.ts";
import { convertTools, type LegacyTool } from "../common/convert-tools.ts";
import { askUserQuestionTools } from "../common/tools/ask-user-question.ts";
import { laborLookupTools } from "../common/tools/labor-lookup.ts";
import { partsLookupTools } from "../common/tools/parts-lookup.ts";
import { createFixoEstimateTool } from "./tools/fixo-estimate.ts";
import { updateDiagnosticStateTool } from "./tools/diagnostic-state.ts";
import { isolateSystemsTool } from "./tools/system-isolation.ts";
import { planPinpointTestsTool } from "./tools/pinpoint-test-plan.ts";
import { emitDiagnosisTool } from "./tools/emit-diagnosis.ts";

const DEFAULT_MODEL = "gemini-3-flash-preview";

const logger = getLogger(["hmls", "agent", "fixo"]);

export interface RunFixoAgentOptions {
  messages: ModelMessage[];
  userId?: string;
  /** Active fixo_sessions.id. Required for tools that mutate session-scoped
   *  state (update_diagnostic_state). Optional only because legacy callers
   *  predate the diagnostic-state work — new callers should always pass it. */
  fixoSessionId?: number;
  /** When provided, overrides the constant SYSTEM_PROMPT. Used by the gateway
   * after buildAgentContext attaches a "Known facts so far" summary and the
   * current diagnostic state. */
  systemPrompt?: string;
}

export function runFixoAgent(options: RunFixoAgentOptions) {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required");
  }

  const modelId = Deno.env.get("AGENT_MODEL") || DEFAULT_MODEL;
  const google = createGoogleGenerativeAI({ apiKey });

  const allTools: LegacyTool[] = [
    extractVideoFramesTool,
    lookupObdCodeTool,
    ...askUserQuestionTools,
    ...laborLookupTools,
    ...partsLookupTools,
    createFixoEstimateTool,
    updateDiagnosticStateTool,
    isolateSystemsTool,
    planPinpointTestsTool,
    emitDiagnosisTool,
  ];

  const tools = convertTools(allTools, {
    userId: options.userId,
    fixoSessionId: options.fixoSessionId,
  });
  logger.info("Initializing Fixo agent", {
    model: modelId,
    toolCount: Object.keys(tools).length,
    hasInjectedSummary: typeof options.systemPrompt === "string",
  });

  return streamText({
    model: google(modelId),
    system: options.systemPrompt ?? SYSTEM_PROMPT,
    messages: options.messages,
    tools,
    // emit_diagnosis is the terminal capture tool for the one-shot structured
    // path — stop as soon as it's called so we don't burn an extra model step
    // (or wander into more tool calls) after the payload is captured.
    stopWhen: [
      stepCountIs(10),
      hasToolCall("ask_user_question"),
      hasToolCall("emit_diagnosis"),
    ],
    onStepFinish: (step) => {
      const toolCalls = step.toolCalls ?? [];
      if (toolCalls.length > 0) {
        logger.debug("Step tool calls", {
          toolNames: toolCalls.map((t) => t.toolName),
        });
      }
      if (step.finishReason && step.finishReason !== "tool-calls") {
        logger.info("Agent step finished", {
          finishReason: step.finishReason,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
        });
      }
    },
  });
}
