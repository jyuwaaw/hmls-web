# Fixo MCP Server (hand-rolled, in-process) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Fixo brain over an MCP (Model Context Protocol) endpoint so a shop's own agent
(BYO agent) can call `diagnose` + `record_outcome` as MCP tools — closing the calibration loop over
a standard protocol.

**Architecture:** Hand-rolled minimal **stateless** MCP Streamable-HTTP server on Hono
(`POST /v1/mcp`), key-gated by the existing api-key middleware. A PURE JSON-RPC dispatch module
(test-safe, no agent imports) takes an injected tool registry; production wires two tools that wrap
the existing in-process brain functions. NO MCP SDK dependency (the spike below proved it doesn't
fit Deno+Hono).

**Tech Stack:** Deno, Hono, zod v4 (`z.toJSONSchema` is native), JSON-RPC 2.0. In-process brain
calls (`@hmls/agent`). Tests: `deno test`.

## Spike result (why hand-rolled)

Verified 2026-06-21: the official `@modelcontextprotocol/sdk` does not fit this runtime. Stable 1.x
ships only the **Node** `StreamableHTTPServerTransport` (wants node `req`/`res`); the web-standard
`WebStandardStreamableHTTPServerTransport` exists only in the **2.0-alpha**
`@modelcontextprotocol/server`, which **fails to import in Deno** (missing transitive
`@cfworker/json-schema`) and is alpha-unstable. So we hand-roll the small, stable MCP wire protocol.
(Supersedes the SDK assumption in
`docs/superpowers/specs/2026-06-21-fixo-structured-tool-surface-design.md`.)

## Global Constraints

- NO new runtime dependency for the server. Do NOT add
  `@modelcontextprotocol/sdk`/`@modelcontextprotocol/server` to the gateway runtime. (The 1.x SDK
  **client** may be imported in ONE test file via a `npm:` specifier — test-only — for the
  protocol-compat check.)
- The JSON-RPC dispatch logic MUST live in a PURE module that does NOT import the heavy agent graph
  (`@hmls/agent`, `runFixoAgent`, react-pdf) — `deno test` loads it directly. Mirror the existing
  `run-once-prompt.ts` / `diagnose-drain.ts` split. Tool _execution_ (which imports the brain) is a
  separate module.
- Stateless: no MCP sessions, no SSE. Each `POST /v1/mcp` carries one JSON-RPC message; respond
  `application/json`. The only cross-call state is the `prediction_id` the consumer carries.
- MCP protocol version string: `"2025-06-18"`. JSON-RPC error codes: `-32700` parse error, `-32601`
  method not found, `-32602` invalid params. Tool _execution_ failures are reported in-band as
  `{ content:[...], isError:true }` (a `result`, NOT a JSON-RPC `error`).
- Key-gated by the EXISTING `requireApiKey` (which calls `authenticateApiKey`) on `/v1/*` in
  `fixo-app.ts`. NO rate limiting (internal dogfood only). HARD GATE for later: rate limiting is
  required before any EXTERNAL key is issued — out of scope here.
- No DB migration (reuses `fixo_predictions`). `deno task check` + `deno lint` + `deno fmt` clean.
  Conventional commits ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File structure

- **Create** `apps/gateway/src/routes/fixo/mcp/jsonrpc.ts` — PURE JSON-RPC dispatch
  (`handleMcpMessage`, `McpTool` type). No agent imports.
- **Create** `apps/gateway/src/routes/fixo/mcp/jsonrpc_test.ts` — dispatch unit tests with stub
  tools.
- **Create** `apps/gateway/src/routes/fixo/mcp/tools.ts` — the two real tools wrapping the brain.
- **Create** `apps/gateway/src/routes/fixo/mcp/route.ts` — the Hono `POST /` handler that drives
  `handleMcpMessage` with the real tools.
- **Create** `apps/gateway/src/routes/fixo/mcp/compat_test.ts` — real-MCP-client round-trip (SDK 1.x
  client → live local server with stub tools).
- **Modify** `apps/agent/src/fixo/fixo-brain.ts` — add
  `diagnoseForApi(req) → { predictionId, diagnosis }`.
- **Modify** `apps/agent/src/mod.ts` — export `diagnoseForApi`, `recordOutcome`, and the needed
  types.
- **Modify** `apps/gateway/src/fixo-app.ts` — mount `app.route("/v1/mcp", fixoMcp)` (under the
  existing `/v1/*` key gate).

---

### Task 1: Pure JSON-RPC dispatch (`mcp/jsonrpc.ts`)

**Files:**

- Create: `apps/gateway/src/routes/fixo/mcp/jsonrpc.ts`
- Test: `apps/gateway/src/routes/fixo/mcp/jsonrpc_test.ts`

**Interfaces:**

- Produces: `McpTool`
  (`{ name, description, inputSchema: z.ZodType, execute: (args:unknown)=>Promise<McpToolResult> }`),
  `McpToolResult`
  (`{ content: {type:"text";text:string}[]; structuredContent?: unknown; isError?: boolean }`),
  `ServerInfo` (`{name:string;version:string}`),
  `handleMcpMessage(msg, tools, serverInfo): Promise<object|null>` (null = notification, no
  response).

- [ ] **Step 1: Write the failing test**

```ts
// jsonrpc_test.ts
import { assert, assertEquals } from "jsr:@std/assert";
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
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `deno test apps/gateway/src/routes/fixo/mcp/jsonrpc_test.ts` Expected: FAIL —
`Module not found "./jsonrpc.ts"`.

- [ ] **Step 3: Implement `jsonrpc.ts`**

```ts
// mcp/jsonrpc.ts — PURE MCP Streamable-HTTP JSON-RPC dispatch. NO agent imports.
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (args: unknown) => Promise<McpToolResult> | McpToolResult;
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
        return ok(id, await tool.execute(parsed.data));
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
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `deno test apps/gateway/src/routes/fixo/mcp/jsonrpc_test.ts` Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/fixo/mcp/jsonrpc.ts apps/gateway/src/routes/fixo/mcp/jsonrpc_test.ts
git commit -m "feat(fixo-mcp): pure JSON-RPC dispatch for the hand-rolled MCP server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `diagnoseForApi` (id + full structured diagnosis) + exports

**Files:**

- Modify: `apps/agent/src/fixo/fixo-brain.ts`
- Modify: `apps/agent/src/mod.ts`

**Interfaces:**

- Consumes: existing `openPrediction`, `diagnoseStructured`, `toOnceVehicle`, `db`, `schema`,
  `DiagnoseRequest`, `StructuredDiagnosis`.
- Produces:
  `diagnoseForApi(req: DiagnoseRequest): Promise<{ predictionId: string; diagnosis: StructuredDiagnosis }>`.
  Re-exported from `@hmls/agent` along with `recordOutcome`, `type OutcomeRequest`,
  `type DiagnoseRequest`.

**Why:** `brain.diagnose` returns the slim `DiagnoseResult` (drops
`narrative`/`safety_flags`/`to_confirm`). The MCP `diagnose` tool needs the FULL
`StructuredDiagnosis` AND a `prediction_id` (so the consumer can close the loop). `diagnoseForApi`
returns both, reusing the existing pieces.

- [ ] **Step 1: Add `diagnoseForApi` to `fixo-brain.ts`**

Add the import for the type (top of file, with the other type imports):

```ts
import type { StructuredDiagnosis } from "./diagnosis-schema.ts";
```

Add the function (after `fillPrediction`):

```ts
/** API path: mint a prediction id + run the full structured diagnosis + store it,
 *  returning BOTH the id (for record_outcome) and the full StructuredDiagnosis.
 *  Used by the MCP `diagnose` tool. */
export async function diagnoseForApi(
  req: DiagnoseRequest,
): Promise<{ predictionId: string; diagnosis: StructuredDiagnosis }> {
  const predictionId = await openPrediction(req);
  const diagnosis = await diagnoseStructured({
    vehicle: toOnceVehicle(req),
    symptom: req.symptom,
    dtcs: req.dtcs,
  });
  await db
    .update(schema.fixoPredictions)
    .set({ predictedDiagnosis: diagnosis })
    .where(eq(schema.fixoPredictions.id, predictionId));
  return { predictionId, diagnosis };
}
```

- [ ] **Step 2: Export from `mod.ts`**

In `apps/agent/src/mod.ts`, extend the fixo exports:

```ts
export { diagnoseForApi, recordOutcome } from "./fixo/fixo-brain.ts";
export { type DiagnoseRequest, type OutcomeRequest } from "./fixo/brain-service.ts";
```

(Keep the existing `diagnoseStructured` / `StructuredDiagnosis` export.)

- [ ] **Step 3: Type-check**

Run: `deno task check` Expected: clean (gateway + agent).

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/fixo/fixo-brain.ts apps/agent/src/mod.ts
git commit -m "feat(fixo): diagnoseForApi — prediction_id + full structured diagnosis for the API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The two real MCP tools (`mcp/tools.ts`)

**Files:**

- Create: `apps/gateway/src/routes/fixo/mcp/tools.ts`

**Interfaces:**

- Consumes: `McpTool` (Task 1), `diagnoseForApi` + `recordOutcome` (Task 2, from `@hmls/agent`).
- Produces: `fixoMcpTools: McpTool[]`.

- [ ] **Step 1: Implement `tools.ts`**

```ts
// mcp/tools.ts — the real Fixo MCP tools, wrapping the in-process brain.
import { z } from "zod";
import { diagnoseForApi, recordOutcome } from "@hmls/agent";
import type { McpTool } from "./jsonrpc.ts";

const diagnoseInput = z.object({
  vehicle: z.object({
    year: z.union([z.number(), z.string()]),
    make: z.string().min(1),
    model: z.string().min(1),
  }),
  symptom: z.string().min(1),
  dtcs: z.array(z.string()).optional(),
});

const recordOutcomeInput = z.object({
  prediction_id: z.string().min(1),
  confirmed_diagnosis: z.string().min(1),
  actual_cost_cents: z.number().int().nonnegative().optional(),
});

export const fixoMcpTools: McpTool[] = [
  {
    name: "diagnose",
    description:
      "Diagnose a vehicle symptom. Returns a prediction_id (echo it back via record_outcome " +
      "once the real fix is confirmed) and a structured diagnosis (candidate systems, likely " +
      "root cause, recommended tests, safety flags, things to confirm).",
    inputSchema: diagnoseInput,
    execute: async (args) => {
      const a = args as z.infer<typeof diagnoseInput>;
      // year coerced to string for VehicleInfo (deno check arbitrates if the
      // VehicleInfo.year type differs; coerce here to be safe).
      const { predictionId, diagnosis } = await diagnoseForApi({
        vehicle: { year: String(a.vehicle.year), make: a.vehicle.make, model: a.vehicle.model },
        symptom: a.symptom,
        dtcs: a.dtcs,
      });
      const out = { prediction_id: predictionId, diagnosis };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  },
  {
    name: "record_outcome",
    description: "Close the diagnostic loop: report what the repair actually was, keyed by the " +
      "prediction_id returned from diagnose. Feeds Fixo's calibration data.",
    inputSchema: recordOutcomeInput,
    execute: async (args) => {
      const a = args as z.infer<typeof recordOutcomeInput>;
      await recordOutcome({
        predictionId: a.prediction_id,
        confirmedDiagnosis: a.confirmed_diagnosis,
        actualCostCents: a.actual_cost_cents,
      });
      const out = { ok: true };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  },
];
```

- [ ] **Step 2: Type-check**

Run: `deno check apps/gateway/src/routes/fixo/mcp/tools.ts` Expected: clean. (If `vehicle.year` type
mismatches `DiagnoseRequest`/`VehicleInfo`, the `String()` coercion above resolves it; if
`deno check` still complains, adjust the coercion per the error — do NOT widen the brain types.)

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/routes/fixo/mcp/tools.ts
git commit -m "feat(fixo-mcp): diagnose + record_outcome tools wrapping the in-process brain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: The Hono route + mount on the gateway (key-gated)

**Files:**

- Create: `apps/gateway/src/routes/fixo/mcp/route.ts`
- Modify: `apps/gateway/src/fixo-app.ts`

**Interfaces:**

- Consumes: `handleMcpMessage` (Task 1), `fixoMcpTools` (Task 3).
- Produces: `fixoMcp` (a Hono router) mounted at `/v1/mcp`.

- [ ] **Step 1: Implement `route.ts`**

```ts
// mcp/route.ts — POST /v1/mcp : one JSON-RPC message in, one response out.
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
  const res = await handleMcpMessage(msg as any, fixoMcpTools, SERVER_INFO);
  if (res === null) return c.body(null, 202); // notification — no body
  return c.json(res);
});
```

- [ ] **Step 2: Mount it in `fixo-app.ts` under the existing `/v1/*` key gate**

In `apps/gateway/src/fixo-app.ts`: import the router and mount it alongside the existing `/v1`
route. The existing `app.use("/v1/*", requireApiKey)` already gates it (verify that line is present
and precedes the mount).

```ts
import { fixoMcp } from "./routes/fixo/mcp/route.ts";
// ...where routes are mounted (near app.route("/v1", fixoApi)):
app.route("/v1/mcp", fixoMcp);
```

(If `/v1/*` is NOT already gated by `requireApiKey`, add `app.use("/v1/mcp", requireApiKey)` before
the mount. Confirm by reading the current `fixo-app.ts`.)

- [ ] **Step 3: Type-check the gateway**

Run: `deno check apps/gateway/src/index.ts` Expected: clean.

- [ ] **Step 4: Manual smoke (raw JSON-RPC, no live LLM)**

Start the gateway locally (`infisical run --env=dev -- deno task dev:api`) in one shell. In another,
mint a key
(`infisical run --env=dev -- deno run -A apps/agent/src/scripts/mint-fixo-key.ts mcp-smoke`) and:

```bash
curl -s -X POST http://fixo.localhost:8080/v1/mcp -H "Authorization: Bearer <key>" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

Expected: JSON with `result.tools` listing `diagnose` + `record_outcome` and their `inputSchema`.
(Don't call `diagnose` here — that hits the live LLM; the compat test in Task 5 covers round-trips
with stub tools.)

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/fixo/mcp/route.ts apps/gateway/src/fixo-app.ts
git commit -m "feat(fixo-mcp): mount POST /v1/mcp on the gateway (key-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Protocol-compat test against a REAL MCP client

**Files:**

- Create: `apps/gateway/src/routes/fixo/mcp/compat_test.ts`

**Interfaces:**

- Consumes: `handleMcpMessage` (Task 1). Imports the `@modelcontextprotocol/sdk` 1.x **client** via
  `npm:` (test-only — NOT a gateway runtime dep).

**Why:** Hand-rolled protocol = we own compatibility. This proves a real MCP client (the kind Cursor
/ Claude Desktop / the AI SDK use) can `initialize` + `tools/list` + `tools/call` against our
server. Uses stub tools so it needs no LLM/DB/key. This is the verify-the-contract-live step.

- [ ] **Step 1: Write the compat test**

```ts
// compat_test.ts — real MCP client (SDK 1.x) round-trips against our hand-rolled server.
import { assert, assertEquals } from "jsr:@std/assert";
import { z } from "zod";
import { Hono } from "hono";
import { Client } from "npm:@modelcontextprotocol/sdk@1.18.0/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.18.0/client/streamableHttp.js";
import { handleMcpMessage, type McpTool } from "./jsonrpc.ts";

const stub: McpTool[] = [{
  name: "ping",
  description: "Echo a message.",
  inputSchema: z.object({ msg: z.string() }),
  execute: (args) =>
    Promise.resolve({ content: [{ type: "text", text: `pong:${(args as { msg: string }).msg}` }] }),
}];

Deno.test("real MCP client: initialize + tools/list + tools/call round-trip", async () => {
  const app = new Hono();
  app.post("/mcp", async (c) => {
    const msg = await c.req.json();
    // deno-lint-ignore no-explicit-any
    const r = await handleMcpMessage(msg as any, stub, { name: "fixo", version: "1.0.0" });
    return r === null ? c.body(null, 202) : c.json(r);
  });
  const server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;

  const client = new Client({ name: "compat-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  try {
    await client.connect(transport); // performs initialize
    const list = await client.listTools();
    assert(list.tools.some((t) => t.name === "ping"), "ping should be listed");
    const res = await client.callTool({ name: "ping", arguments: { msg: "hi" } });
    // deno-lint-ignore no-explicit-any
    assertEquals((res.content as any)[0].text, "pong:hi");
  } finally {
    await client.close().catch(() => {});
    await server.shutdown();
  }
});
```

- [ ] **Step 2: Run it**

Run: `deno test --allow-net apps/gateway/src/routes/fixo/mcp/compat_test.ts` Expected: PASS. If the
SDK 1.x client fails to import or its Streamable-HTTP client can't talk to a stateless server (some
client versions demand a session id), report it: fall back to asserting the round-trip with a raw
`fetch` JSON-RPC sequence (initialize → tools/list → tools/call) instead, and note that the
SDK-client check is deferred. Do NOT add the SDK to the gateway runtime deps to make this pass.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/routes/fixo/mcp/compat_test.ts
git commit -m "test(fixo-mcp): real MCP client (SDK) round-trips against the hand-rolled server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred (NOT in this plan)

- `estimate` MCP tool — no clean standalone estimate function exists yet; add when one does.
- Rate limiting + metering — required before any EXTERNAL key is issued (hard gate). Internal
  dogfood needs none.
- SSE / streaming responses + MCP sessions — not needed for stateless tools.
- HMLS's own agent consuming this MCP endpoint as a client — separate plan (AI SDK `ai@6.0.169` has
  no MCP client; needs a wrapper or an upgrade).

## Risks

- **SDK 1.x client in the compat test:** if the client's Streamable-HTTP transport insists on a
  session id (some versions send `Mcp-Session-Id` and expect one back), our stateless server may not
  satisfy it. Mitigation in Task 5 Step 2: fall back to a raw-`fetch` JSON-RPC round-trip assertion.
  Either way the protocol shape is verified; the SDK-client path is the stronger proof when it
  works.
- **`z.toJSONSchema` output shape:** zod v4's `z.toJSONSchema` emits draft-2020-12 JSON Schema. MCP
  clients accept standard JSON Schema for `inputSchema`; Task 1's test asserts `type:"object"` +
  `properties`. If a client rejects a specific keyword, narrow the schema — don't hand-write JSON
  Schema.
- **`prediction_id` round-trip is the moat:** the `diagnose` tool returning `prediction_id` +
  `record_outcome` accepting it is what closes the loop for external shops. Keep the field name
  `prediction_id` stable in the tool contract.
