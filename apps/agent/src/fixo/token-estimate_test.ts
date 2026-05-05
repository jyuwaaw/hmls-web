import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { ModelMessage } from "ai";
import { estimateTokens } from "./token-estimate.ts";

Deno.test("estimateTokens — empty array", () => {
  assertEquals(estimateTokens([]), 0);
});

Deno.test("estimateTokens — single text message", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "hello world" }, // 11 chars
  ];
  assertEquals(estimateTokens(messages), Math.ceil(11 / 3.5));
});

Deno.test("estimateTokens — multipart message", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "hi" }, // 2
        { type: "text", text: "there" }, // 5
      ],
    },
  ];
  assertEquals(estimateTokens(messages), Math.ceil(7 / 3.5));
});

Deno.test("estimateTokens — tool result", () => {
  const messages: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "x",
          output: { type: "text", value: "abcdefghij" },
        },
      ],
    },
  ];
  // 10 chars in stringified output (approximately — JSON.stringify wraps it, ~30 chars total)
  const result = estimateTokens(messages);
  assertAlmostEquals(result, Math.ceil(30 / 3.5), 5);
});
