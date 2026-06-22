import { Hono } from "hono";
import { cors } from "hono/cors";
import { getLogger, withContext } from "@logtape/logtape";
import { AppError } from "@hmls/shared/errors";
import { requestContext } from "./middleware/request-context.ts";
import { type AuthContext, authenticateRequest } from "./middleware/fixo/auth.ts";
import { sessions } from "./routes/fixo/sessions.ts";
import { input } from "./routes/fixo/input.ts";
import { chat } from "./routes/fixo/chat.ts";
import { billing, webhookHandler } from "./routes/fixo/billing.ts";
import { reports } from "./routes/fixo/reports.ts";
import { complete } from "./routes/fixo/complete.ts";
import { vehicleRoutes } from "./routes/fixo/vehicles.ts";
import { funnel } from "./routes/fixo/funnel.ts";
import { fixoApi } from "./routes/fixo/api.ts";
import { fixoMcp } from "./routes/fixo/mcp/route.ts";
import { type ApiKeyContext, authenticateApiKey } from "./middleware/fixo/api-key.ts";

const DEV_MODE = Deno.env.get("DEV_MODE") === "true";

const logger = getLogger(["hmls", "gateway", "fixo"]);

export function createFixoApp() {
  const app = new Hono<{ Variables: { auth: AuthContext; apiKey: ApiKeyContext } }>();

  // CORS — fixo origins only
  app.use(
    "*",
    cors({
      origin: [
        "https://fixo.hmls.autos",
        "https://fixo.ink",
        "http://localhost:3000",
        "http://localhost:3001",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );
  app.use("*", requestContext);

  // Global error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      logger.warn("AppError {code}: {message}", {
        code: err.code,
        message: err.message,
        status: err.status,
      });
      return c.json(
        err.toJSON(),
        err.status as 400 | 401 | 403 | 404 | 422 | 500 | 502,
      );
    }
    logger.error("Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    }, 500);
  });

  // 404 handler
  app.notFound((c) => {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Route not found" } },
      404,
    );
  });

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "fixo",
      timestamp: new Date().toISOString(),
    });
  });

  // deno-lint-ignore no-explicit-any -- Hono middleware type compatibility
  const requireAuth = async (c: any, next: any) => {
    const authResult = await authenticateRequest(c.req.raw);
    if (authResult instanceof Response) return authResult;
    c.set("auth", authResult);
    await withContext(
      { userId: authResult.userId, tier: authResult.tier },
      next,
    );
  };

  // deno-lint-ignore no-explicit-any -- Hono middleware type compatibility
  const requireApiKey = async (c: any, next: any) => {
    const result = await authenticateApiKey(c.req.raw);
    if (result instanceof Response) return result;
    c.set("apiKey", result);
    await next();
  };

  app.use("/sessions/*", requireAuth);
  app.use("/reports/*", requireAuth);
  app.use("/billing/checkout", requireAuth);
  app.use("/billing/topup", requireAuth);
  app.use("/billing/balance", requireAuth);
  app.use("/billing/history", requireAuth);
  app.use("/billing/usage", requireAuth);
  app.use("/billing/redeem", requireAuth);
  app.use("/billing/portal", requireAuth);
  app.use("/vehicles", requireAuth);
  app.use("/vehicles/*", requireAuth);
  app.use("/task", async (c, next) => {
    if (DEV_MODE) {
      logger.info("DEV_MODE: skipping auth");
      const devUserId = "00000000-0000-0000-0000-000000000001";
      c.set("auth", {
        userId: devUserId,
        email: "dev@localhost",
        tier: "plus" as const,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      });
      await withContext({ userId: devUserId, tier: "plus" }, next);
      return;
    }
    return requireAuth(c, next);
  });

  // Mount routes
  app.route("/sessions", sessions);
  app.route("/sessions", input);
  app.route("/reports", reports);
  app.route("/sessions", complete);
  app.route("/task", chat);
  app.route("/vehicles", vehicleRoutes);
  app.route("/billing", billing);
  app.route("/billing/webhook", webhookHandler);
  // /funnel/track is intentionally PUBLIC (no requireAuth) — SEO and
  // email-CTA hits happen pre-signin. The route's own auth-aware logic
  // attributes events to userId when an auth cookie is present.
  app.route("/funnel", funnel);

  // Public API (v1) — key-gated diagnostic brain. diagnose/estimate over REST.
  app.use("/v1/*", requireApiKey);
  app.route("/v1", fixoApi);
  app.route("/v1/mcp", fixoMcp);

  return app;
}
