import { Hono } from "hono";
import { handleMcpMessage } from "./jsonrpc.ts";
import { fixoMcpTools } from "./tools.ts";

const SERVER_INFO = { name: "fixo", version: "1.0.0" };

export const fixoMcp = new Hono();

fixoMcp.post("/", async (c) => {
  let msg: unknown;
  try {
    msg = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      400,
    );
  }
  // deno-lint-ignore no-explicit-any
  const apiKey = (c as any).get("apiKey") as { id: string } | undefined;
  // deno-lint-ignore no-explicit-any
  const res = await handleMcpMessage(msg as any, fixoMcpTools, SERVER_INFO, {
    apiKeyId: apiKey?.id,
  });
  if (res === null) return c.body(null, 202); // notification — no body
  return c.json(res);
});
