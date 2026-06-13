import { assertEquals } from "@std/assert";
import { findCursorIndex, trimOrphanedToolResults } from "./build-context.ts";
import type { ModelMessage, UIMessage } from "ai";

const role = (r: string): ModelMessage => ({ role: r, content: [] }) as unknown as ModelMessage;

const mk = (id: string): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
  }) as UIMessage;

Deno.test("findCursorIndex — null marker → 0", () => {
  const msgs = [mk("a"), mk("b"), mk("c")];
  assertEquals(findCursorIndex(msgs, null), 0);
});

Deno.test("findCursorIndex — marker present → idx + 1", () => {
  const msgs = [mk("a"), mk("b"), mk("c")];
  assertEquals(findCursorIndex(msgs, "b"), 2);
});

Deno.test("findCursorIndex — marker missing → 0 + warn", () => {
  const msgs = [mk("a"), mk("b")];
  assertEquals(findCursorIndex(msgs, "ghost"), 0);
});

// Regression: session 43 (brake + scheduling) errored with Gemini's
// "function response turn comes immediately after a function call turn".
// slice(-12) over interleaved assistant/tool messages orphaned a leading
// `tool` (functionResponse). This is the exact window roles from that session.
Deno.test("trimOrphanedToolResults — fixes session-43 orphaned window", () => {
  const window43 = [
    "tool",
    "assistant",
    "tool",
    "assistant",
    "tool",
    "assistant",
    "tool",
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
  ].map(role);
  assertEquals(window43[0].role, "tool"); // the bug: orphaned functionResponse
  const fixed = trimOrphanedToolResults(window43);
  assertEquals(fixed[0].role, "assistant"); // window now starts clean
  // Gemini contract: every tool (functionResponse) must follow an assistant.
  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i].role === "tool") {
      assertEquals(fixed[i - 1]?.role, "assistant", `tool at ${i} must follow assistant`);
    }
  }
});

Deno.test("trimOrphanedToolResults — clean window (leading user) unchanged", () => {
  const msgs = [role("user"), role("assistant"), role("tool"), role("assistant")];
  assertEquals(trimOrphanedToolResults(msgs), msgs);
});

Deno.test("trimOrphanedToolResults — leading assistant tool-call kept (valid Gemini start)", () => {
  const msgs = [role("assistant"), role("tool"), role("user")];
  assertEquals(trimOrphanedToolResults(msgs), msgs);
});

Deno.test("trimOrphanedToolResults — multiple leading tools all dropped", () => {
  const msgs = [role("tool"), role("tool"), role("user"), role("assistant")];
  assertEquals(trimOrphanedToolResults(msgs).map((m) => m.role), ["user", "assistant"]);
});

Deno.test("trimOrphanedToolResults — all-tool window falls back to original (never empty)", () => {
  const msgs = [role("tool"), role("tool")];
  // Guard: returning [] would make Gemini reject an empty message list.
  assertEquals(trimOrphanedToolResults(msgs), msgs);
});
