import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}
export interface McpCallCtx {
  apiKeyId?: string;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (args: unknown, ctx?: McpCallCtx) => Promise<McpToolResult> | McpToolResult;
}
export interface ServerInfo {
  name: string;
  version: string;
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  // deno-lint-ignore no-explicit-any
  params?: any;
}

const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/** Dispatch one MCP JSON-RPC message. Returns the response object, or `null`
 *  for notifications (no response body). Pure — tools + serverInfo injected. */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  tools: McpTool[],
  serverInfo: ServerInfo,
  ctx?: McpCallCtx,
): Promise<object | null> {
  const id: JsonRpcId = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo,
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema),
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${msg.params?.name}`);
      const parsed = tool.inputSchema.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) return err(id, -32602, `Invalid arguments: ${parsed.error.message}`);
      try {
        return ok(id, await tool.execute(parsed.data, ctx));
      } catch (e) {
        // MCP convention: tool failures are in-band results with isError, not protocol errors.
        return ok(id, {
          content: [{
            type: "text",
            text: `Tool failed: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        });
      }
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}
