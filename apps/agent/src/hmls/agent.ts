import { hasToolCall, type ModelMessage, stepCountIs, streamText } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { getLogger } from "@logtape/logtape";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { loadSkillTools } from "../common/tools/load-skill.ts";
import { schedulingTools } from "./tools/scheduling.ts";
import { orderOpsTools } from "./tools/order-ops.ts";
import { customerOrderActionTools } from "./tools/customer-order-actions.ts";
import { customerBookingActionTools } from "./tools/customer-booking-actions.ts";
import { formatUserContext, type UserContext } from "../types/user-context.ts";
import { convertTools, type LegacyTool } from "../common/convert-tools.ts";
import { askUserQuestionTools } from "../common/tools/ask-user-question.ts";
import { collectContactTools } from "../common/tools/collect-contact.ts";
import { laborLookupTools } from "../common/tools/labor-lookup.ts";
import { partsLookupTools } from "../common/tools/parts-lookup.ts";
import { orderTools } from "../common/tools/order.ts";
import { scheduleTools } from "../common/tools/schedule.ts";
import { diagnoseSymptomTools } from "./tools/diagnose-symptom.ts";

const logger = getLogger(["hmls", "agent", "hmls"]);

const DEFAULT_MODEL = "deepseek-v4-pro";

export interface RunAgentOptions {
  messages: ModelMessage[];
  userContext?: UserContext;
  /** Multi-tenancy: the shop the customer belongs to (stamped at first-contact
   *  upsert). Threads into every tool so order/customer reads are shop-scoped. */
  shopId?: string;
}

export function runHmlsAgent(options: RunAgentOptions) {
  const { messages, userContext, shopId } = options;
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
  const modelId = Deno.env.get("HMLS_AGENT_MODEL") || DEFAULT_MODEL;
  // ponytail: DeepSeek is text-only — any in-chat image part is silently dropped.
  // HMLS chat is text-only today (intake photos ride on the order, not the stream).
  const deepseek = createDeepSeek({ apiKey });

  const parts = [SYSTEM_PROMPT];
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
    ...diagnoseSymptomTools,
    ...askUserQuestionTools,
    ...collectContactTools,
    ...loadSkillTools,
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
    model: deepseek(modelId),
    system: systemPrompt,
    messages,
    tools,
    stopWhen: [stepCountIs(25), hasToolCall("ask_user_question"), hasToolCall("collect_contact")],
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
