import { assert, assertEquals } from "@std/assert";
import { LOADABLE_SKILLS, readSkillBody } from "./load-skills.ts";

Deno.test("readSkillBody: returns the order skill body with frontmatter stripped", async () => {
  const body = await readSkillBody("order");
  assert(body !== null, "order skill should exist");
  assert(body!.includes("# Order Skill"), "body should start at the heading");
  assert(!body!.includes("description:"), "YAML frontmatter must be stripped");
});

Deno.test("readSkillBody: returns null for an unknown skill", async () => {
  assertEquals(await readSkillBody("does-not-exist"), null);
});

Deno.test("LOADABLE_SKILLS: v1 is order + scheduling only", () => {
  assertEquals([...LOADABLE_SKILLS], ["order", "scheduling"]);
});
