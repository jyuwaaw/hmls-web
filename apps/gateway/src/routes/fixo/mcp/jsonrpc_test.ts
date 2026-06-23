// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { handleMcpMessage, type McpTool } from "./jsonrpc.ts";

const stub: McpTool[] = [{
  name: "ping",
  description: "Echo a message.",
  inputSchema: z.object({ msg: z.string() }),
  execute: (args) =>
    Promise.resolve({ content: [{ type: "text", text: `pong:${(args as { msg: string }).msg}` }] }),
}];
const info = { name: "fixo-test", version: "0.0.0" };

Deno.test("initialize returns protocolVersion + tools capability", async () => {
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    stub,
    info,
  ) as any;
  assertEquals(r.result.protocolVersion, "2025-06-18");
  assert(r.result.capabilities.tools);
  assertEquals(r.result.serverInfo.name, "fixo-test");
});

Deno.test("notifications/initialized returns null (no response)", async () => {
  assertEquals(
    await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, stub, info),
    null,
  );
});

Deno.test("tools/list returns ping with a JSON-schema inputSchema", async () => {
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    stub,
    info,
  ) as any;
  assertEquals(r.result.tools[0].name, "ping");
  assertEquals(r.result.tools[0].inputSchema.type, "object");
  assert(r.result.tools[0].inputSchema.properties.msg);
});

Deno.test("tools/call runs the tool", async () => {
  const r = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ping", arguments: { msg: "hi" } },
    },
    stub,
    info,
  ) as any;
  assertEquals(r.result.content[0].text, "pong:hi");
});

Deno.test("tools/call unknown tool -> -32602", async () => {
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } },
    stub,
    info,
  ) as any;
  assertEquals(r.error.code, -32602);
});

Deno.test("tools/call invalid args -> -32602", async () => {
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ping", arguments: {} } },
    stub,
    info,
  ) as any;
  assertEquals(r.error.code, -32602);
});

Deno.test("tool execution throw -> isError result, not JSON-RPC error", async () => {
  const boom: McpTool[] = [{
    name: "boom",
    description: "x",
    inputSchema: z.object({}),
    execute: () => {
      throw new Error("kaboom");
    },
  }];
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "boom", arguments: {} } },
    boom,
    info,
  ) as any;
  assertEquals(r.result.isError, true);
  assert(r.result.content[0].text.includes("kaboom"));
});

Deno.test("unknown method -> -32601", async () => {
  const r = await handleMcpMessage(
    { jsonrpc: "2.0", id: 7, method: "resources/list" },
    stub,
    info,
  ) as any;
  assertEquals(r.error.code, -32601);
});

Deno.test("tools/call threads ctx to execute", async () => {
  let seen: unknown;
  const tools = [{
    name: "echo",
    description: "x",
    inputSchema: z.object({}),
    execute: (_args: unknown, ctx?: { apiKeyId?: string }) => {
      seen = ctx?.apiKeyId;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  }];
  await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } },
    tools,
    { name: "t", version: "0" },
    { apiKeyId: "key-123" },
  );
  assertEquals(seen, "key-123");
});
