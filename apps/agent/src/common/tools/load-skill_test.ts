import { assert } from "@std/assert";
import { loadSkillTool } from "./load-skill.ts";

Deno.test("load_skill: returns the requested skill body", async () => {
  const res = await loadSkillTool.execute({ name: "order" }, undefined);
  // toolResult wraps the payload as MCP content; the body must be in there.
  const text = JSON.stringify(res);
  assert(text.includes("Order Skill"), "should return the order skill body");
});
