import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { chat } from "./chat.ts";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

// Validation surface tests for the fixo /task endpoint. These exercise
// the request-shape validation that runs BEFORE any DB or quota work, so
// they don't need DB or env vars. Hydration + agent + counter paths are
// covered by manual smoke + Playwright E2E.

function buildTestApp(auth: AuthContext): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/task", chat);
  return app;
}

const PLUS_AUTH: AuthContext = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "test@example.com",
  tier: "plus",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
};

Deno.test("chat: rejects malformed JSON body", async () => {
  const app = buildTestApp(PLUS_AUTH);
  const res = await app.request("/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Invalid JSON body");
});

Deno.test("chat: rejects body without messages array", async () => {
  const app = buildTestApp(PLUS_AUTH);
  const res = await app.request("/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: 1 }),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "messages array is required");
});

Deno.test("chat: rejects body where messages is not an array", async () => {
  const app = buildTestApp(PLUS_AUTH);
  const res = await app.request("/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: "hi there" }),
  });
  assertEquals(res.status, 400);
});
