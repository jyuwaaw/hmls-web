import { Hono } from "hono";
import { convertToModelMessages } from "ai";
import { type AgentConfig, runStaffAgent } from "@hmls/agent";
import { Errors } from "@hmls/shared/errors";
import { getLogger } from "@logtape/logtape";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";
import { requireShopContext, type WithShop } from "../middleware/shop-context.ts";

const logger = getLogger(["hmls", "gateway", "staff-chat"]);

let _config: AgentConfig;

export function initStaffChat(config: AgentConfig) {
  _config = config;
}

const staffChat = new Hono<WithShop<AdminEnv>>();

staffChat.use("*", requireAdmin);
staffChat.use("*", requireShopContext);

// Staff chat endpoint — requires admin JWT + shop context
staffChat.post("/", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      400,
    );
  }

  const { messages } = body;
  if (!messages || !Array.isArray(messages)) {
    throw Errors.validation("Invalid request", "messages array is required");
  }

  const authUser = c.get("authUser");
  const shopId = c.get("shopId");
  const startTime = Date.now();
  logger.info("Request received", {
    userId: authUser.id,
    shopId,
    messageCount: messages.length,
  });

  try {
    const modelMessages = await convertToModelMessages(messages);

    const result = await runStaffAgent({
      messages: modelMessages,
      config: _config,
      adminEmail: authUser.email ?? undefined,
      shopId,
    });

    const response = result.toUIMessageStreamResponse();
    const duration = Date.now() - startTime;
    logger.info("Request finished", {
      userId: authUser.id,
      messageCount: messages.length,
      duration,
    });
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("Agent failed", {
      userId: authUser.id,
      duration,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json(
      {
        error: {
          code: "AGENT_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    );
  }
});

export { staffChat };
