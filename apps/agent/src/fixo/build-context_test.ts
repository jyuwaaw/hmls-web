import { assertEquals } from "@std/assert";
import { findCursorIndex } from "./build-context.ts";
import type { UIMessage } from "ai";

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
