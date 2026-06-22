import { hasToolCall, type ModelMessage, stepCountIs, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getLogger } from "@logtape/logtape";
import { STAFF_SYSTEM_PROMPT } from "./staff-system-prompt.ts";
import { loadSkills } from "./load-skills.ts";
import { schedulingTools } from "./tools/scheduling.ts";
import { orderOpsTools } from "./tools/order-ops.ts";
import { adminOrderTools } from "./tools/admin-order-tools.ts";
import { convertTools, type LegacyTool } from "../common/convert-tools.ts";
import { askUserQuestionTools } from "../common/tools/ask-user-question.ts";
import { laborLookupTools } from "../common/tools/labor-lookup.ts";
import { partsLookupTools } from "../common/tools/parts-lookup.ts";
import { orderTools } from "../common/tools/order.ts";
import { scheduleTools } from "../common/tools/schedule.ts";
import type { AgentConfig } from "./agent.ts";

const logger = getLogger(["hmls", "agent", "staff"]);

const DEFAULT_MODEL = "gemini-3-flash-preview";

export interface RunStaffAgentOptions {
  messages: ModelMessage[];
  config: AgentConfig;
  /** Admin identity for audit trails. Threaded into every tool as
   *  ctx.adminEmail so the order-state harness can stamp events with the
   *  acting admin, not a generic "staff_agent" string. */
  adminEmail?: string;
  /** Multi-tenancy: the shop this staff chat session belongs to. May be
   *  OWNER_ALL_SHOPS ("__all__") for an owner with no shop filter, which
   *  lets read tools span all shops. */
  shopId?: string;
}

// Same skill bundle as the customer agent — staff also needs the
// pricing reference + state machine.
const SKILLS_PROMISE = loadSkills(["order", "scheduling"]);

export async function runStaffAgent(options: RunStaffAgentOptions) {
  const { messages, config, adminEmail, shopId } = options;
  const modelId = config.agentModel || DEFAULT_MODEL;

  const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey });
  const skills = await SKILLS_PROMISE;
  const systemPrompt = skills ? `${STAFF_SYSTEM_PROMPT}\n\n${skills}` : STAFF_SYSTEM_PROMPT;

  const allTools: LegacyTool[] = [
    ...askUserQuestionTools,
    ...orderTools,
    ...schedulingTools,
    ...scheduleTools,
    ...laborLookupTools,
    ...partsLookupTools,
    ...orderOpsTools,
    ...adminOrderTools,
  ];

  const toolCtx: import("../common/convert-tools.ts").ToolContext = {};
  if (adminEmail) toolCtx.adminEmail = adminEmail;
  if (shopId) toolCtx.shopId = shopId;
  const tools = convertTools(allTools, Object.keys(toolCtx).length > 0 ? toolCtx : undefined);
  const toolCount = Object.keys(tools).length;
  logger.info("Initializing staff agent", { model: modelId, toolCount });

  return streamText({
    model: google(modelId),
    system: systemPrompt,
    messages,
    tools,
    stopWhen: [stepCountIs(25), hasToolCall("ask_user_question")],
    onStepFinish: (step) => {
      const toolCalls = step.toolCalls ?? [];
      if (toolCalls.length > 0) {
        logger.debug("Step tool calls", {
          toolNames: toolCalls.map((t) => t.toolName),
        });
      }
      if (step.finishReason && step.finishReason !== "tool-calls") {
        logger.info("Staff agent step finished", {
          finishReason: step.finishReason,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
        });
      }
    },
  });
}
