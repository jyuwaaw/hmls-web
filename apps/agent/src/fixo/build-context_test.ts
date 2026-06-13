import { assertEquals } from "@std/assert";
import { findCursorIndex, trimToUserTurnStart } from "./build-context.ts";
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

// Gemini's full ordering contract: a windowed conversation must START at a
// `user` turn. Two partial-start shapes are both rejected:
//   - leading `tool`     → "function response turn comes ... after a function call turn"
//   - leading `assistant` functionCall → "function call turn comes ... after a user turn"
// (Both observed live on session 43: the first bug was the leading tool; trimming
// only the tool then exposed the leading assistant functionCall.)
function assertValidGeminiStart(msgs: ModelMessage[]) {
  assertEquals(msgs[0]?.role, "user", "windowed conversation must start at a user turn");
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "tool") {
      assertEquals(msgs[i - 1]?.role, "assistant", `tool at ${i} must follow an assistant`);
    }
  }
}

// Regression: session 43 (brake + scheduling). slice(-12) over interleaved
// assistant/tool messages gave this exact role sequence (leading tool, then a
// leading assistant functionCall once the tool was dropped).
Deno.test("trimToUserTurnStart — session-43 window starts at the first user turn", () => {
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
  const fixed = trimToUserTurnStart(window43);
  assertEquals(fixed.map((m) => m.role), ["user", "assistant", "tool", "assistant", "user"]);
  assertValidGeminiStart(fixed);
});

Deno.test("trimToUserTurnStart — clean window (leading user) unchanged", () => {
  const msgs = [role("user"), role("assistant"), role("tool"), role("assistant")];
  assertEquals(trimToUserTurnStart(msgs), msgs);
  assertValidGeminiStart(trimToUserTurnStart(msgs));
});

Deno.test("trimToUserTurnStart — leading assistant functionCall dropped (NOT a valid start)", () => {
  // The bug the live test caught: a leading assistant tool-call is rejected by
  // Gemini. Trimming must advance to the user turn, not keep the assistant.
  const msgs = [role("assistant"), role("tool"), role("user"), role("assistant")];
  assertEquals(trimToUserTurnStart(msgs).map((m) => m.role), ["user", "assistant"]);
});

Deno.test("trimToUserTurnStart — leading tools + assistant all dropped to user", () => {
  const msgs = [role("tool"), role("tool"), role("assistant"), role("tool"), role("user")];
  assertEquals(trimToUserTurnStart(msgs).map((m) => m.role), ["user"]);
});

Deno.test("trimToUserTurnStart — no user turn falls back to original (never empty)", () => {
  const msgs = [role("tool"), role("assistant"), role("tool")];
  // Unreachable in practice (the live turn is always a user message), but the
  // guard must never return an empty list (Gemini rejects that too).
  assertEquals(trimToUserTurnStart(msgs), msgs);
});
