import { hasToolCall, type ModelMessage, stepCountIs, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getLogger } from "@logtape/logtape";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { loadSkills } from "./load-skills.ts";
import { schedulingTools } from "./tools/scheduling.ts";
import { orderOpsTools } from "./tools/order-ops.ts";
import { customerOrderActionTools } from "./tools/customer-order-actions.ts";
import { customerBookingActionTools } from "./tools/customer-booking-actions.ts";
import { formatUserContext, type UserContext } from "../types/user-context.ts";
import { convertTools, type LegacyTool } from "../common/convert-tools.ts";
import { askUserQuestionTools } from "../common/tools/ask-user-question.ts";
import { laborLookupTools } from "../common/tools/labor-lookup.ts";
import { partsLookupTools } from "../common/tools/parts-lookup.ts";
import { orderTools } from "../common/tools/order.ts";
import { scheduleTools } from "../common/tools/schedule.ts";

const logger = getLogger(["hmls", "agent", "hmls"]);

const DEFAULT_MODEL = "gemini-3-flash-preview";

export interface AgentConfig {
  googleApiKey: string;
  agentModel?: string;
}

export interface RunAgentOptions {
  messages: ModelMessage[];
  config: AgentConfig;
  userContext?: UserContext;
  /** Multi-tenancy: the shop the customer belongs to (stamped at first-contact
   *  upsert). Threads into every tool so order/customer reads are shop-scoped. */
  shopId?: string;
}

// Skill bodies inlined into the system prompt at boot. The customer agent
// needs the order pricing reference + the scheduling state machine; both
// live in `.skills/<name>/skill.md` as the single source of truth.
const SKILLS_PROMISE = loadSkills(["order", "scheduling"]);

export async function runHmlsAgent(options: RunAgentOptions) {
  const { messages, config, userContext, shopId } = options;
  const modelId = config.agentModel || DEFAULT_MODEL;

  const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey });

  const skills = await SKILLS_PROMISE;
  const parts = [SYSTEM_PROMPT];
  if (skills) parts.push(skills);
  if (userContext) parts.push(formatUserContext(userContext));
  const systemPrompt = parts.join("\n\n");

  // Customer agent uses restricted order tools — no direct status transitions,
  // only approve/decline/cancel/request_reschedule + read-only get_order_status
  const customerOrderTools = [
    orderOpsTools.find((t) => t.name === "get_order_status")!,
    orderOpsTools.find((t) => t.name === "add_order_note")!,
    ...customerOrderActionTools,
    ...customerBookingActionTools,
  ];

  const allTools: LegacyTool[] = [
    ...askUserQuestionTools,
    ...orderTools,
    ...schedulingTools,
    ...scheduleTools,
    ...laborLookupTools,
    ...partsLookupTools,
    ...customerOrderTools,
  ];

  const toolCtx: import("../common/convert-tools.ts").ToolContext = {};
  if (userContext) toolCtx.customerId = userContext.id;
  if (shopId) toolCtx.shopId = shopId;
  const tools = convertTools(allTools, Object.keys(toolCtx).length > 0 ? toolCtx : undefined);
  const toolCount = Object.keys(tools).length;
  logger.info("Initializing HMLS agent", { model: modelId, toolCount });

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
        logger.info("Agent step finished", {
          finishReason: step.finishReason,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
        });
      }
    },
  });
}
