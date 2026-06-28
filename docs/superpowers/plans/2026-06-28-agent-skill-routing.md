# Dynamic Skill Routing (`load_skill`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace boot-time `loadSkills(["order","scheduling"])` inlining with an agent-invoked
`load_skill` tool so the HMLS customer + staff agents pull a skill's full playbook on demand.

**Architecture:** A shared `load_skill` tool reads `.skills/<name>/skill.md`, strips frontmatter,
and returns the body as a tool result (which persists in conversation context). Both agents drop the
boot-time skill concat; their base prompts gain a short skill index that tells the model when to
call `load_skill`. The base prompts already carry an operational pricing/booking spine, so a missed
load degrades gracefully.

**Tech Stack:** Deno, AI SDK v6 `streamText`, zod, DeepSeek provider. Spec:
`docs/superpowers/specs/2026-06-28-agent-skill-routing-design.md`.

## Global Constraints

- Deno apps: `deno fmt` (double quotes, 2-space indent, 100-char width) + `deno lint`. Run
  `deno task check` after each code task.
- Loadable skills in v1: `order`, `scheduling` only. Diagnosis skills stay Fixo-only (out of the
  HMLS index).
- `load_skill` is NOT a stop-point — do not add it to either agent's `stopWhen`.
- Verify provider behavior against the live DeepSeek API, not just unit tests (project rule).
- No web changes: `load_skill` is backstage; the customer chat already renders nothing for
  unrecognized tools in `mode="customer"`. Verify this holds (Task 4).

---

### Task 1: Loader — `LOADABLE_SKILLS` + `readSkillBody`

**Files:**

- Modify: `apps/agent/src/hmls/load-skills.ts`
- Test: `apps/agent/src/hmls/load-skills_test.ts` (create)

**Interfaces:**

- Produces: `export const LOADABLE_SKILLS = ["order", "scheduling"] as const`;
  `export type LoadableSkill = (typeof LOADABLE_SKILLS)[number]`;
  `export async function readSkillBody(name: string): Promise<string | null>`.
- `loadSkills(names)` stays for now (removed in Task 3). `stripFrontmatter` + `SKILLS_DIR`
  unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/src/hmls/load-skills_test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -A apps/agent/src/hmls/load-skills_test.ts` Expected: FAIL —
`readSkillBody`/`LOADABLE_SKILLS` not exported.

- [ ] **Step 3: Add the exports to `load-skills.ts`**

After the `stripFrontmatter` function (keep it) and before `loadSkills`, add:

```ts
/** Skills the agents may pull on demand via the `load_skill` tool. v1 = the two
 *  heavy bodies that used to be inlined at boot. Diagnosis skills stay Fixo-only. */
export const LOADABLE_SKILLS = ["order", "scheduling"] as const;
export type LoadableSkill = (typeof LOADABLE_SKILLS)[number];

/** Read one skill's body (frontmatter stripped). null if missing or empty. */
export async function readSkillBody(name: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(new URL(`${name}/skill.md`, SKILLS_DIR));
    const body = stripFrontmatter(raw).trim();
    return body || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test + check to verify they pass**

Run: `deno test -A apps/agent/src/hmls/load-skills_test.ts && deno task check` Expected: 3 tests
PASS; check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/hmls/load-skills.ts apps/agent/src/hmls/load-skills_test.ts
git commit -m "feat(agent): add readSkillBody + LOADABLE_SKILLS loader helpers"
```

---

### Task 2: The `load_skill` tool

**Files:**

- Create: `apps/agent/src/common/tools/load-skill.ts`
- Test: `apps/agent/src/common/tools/load-skill_test.ts`

**Interfaces:**

- Consumes: `LOADABLE_SKILLS`, `readSkillBody` from `../../hmls/load-skills.ts` (Task 1).
- Produces: `export const loadSkillTool` (a `LegacyTool`-shaped object: `name`, `description`,
  `schema`, `execute`); `export const loadSkillTools = [loadSkillTool]`.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/src/common/tools/load-skill_test.ts`:

```ts
import { assert } from "@std/assert";
import { loadSkillTool } from "./load-skill.ts";

Deno.test("load_skill: returns the requested skill body", async () => {
  const res = await loadSkillTool.execute({ name: "order" }, undefined);
  // toolResult wraps the payload as MCP content; the body must be in there.
  const text = JSON.stringify(res);
  assert(text.includes("Order Skill"), "should return the order skill body");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -A apps/agent/src/common/tools/load-skill_test.ts` Expected: FAIL —
`./load-skill.ts` does not exist.

- [ ] **Step 3: Write the tool**

Create `apps/agent/src/common/tools/load-skill.ts`:

```ts
import { z } from "zod";
import { toolResult } from "@hmls/shared/tool-result";
import { LOADABLE_SKILLS, readSkillBody } from "../../hmls/load-skills.ts";

export const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill's full playbook into the conversation. Call this the MOMENT the chat enters " +
    "the skill's area, BEFORE acting — the skill body has the detailed pricing reference / state " +
    "machine that the base rules only summarize. The available skills are listed in your system " +
    "prompt's Skills index. A loaded skill stays available for the rest of the chat; don't reload it.",
  schema: z.object({
    name: z.enum(LOADABLE_SKILLS).describe("Which skill playbook to load"),
  }),
  execute: async (params: { name: (typeof LOADABLE_SKILLS)[number] }, _ctx: unknown) => {
    const body = await readSkillBody(params.name);
    if (!body) {
      return toolResult({ success: false, error: `Skill '${params.name}' not found` });
    }
    return toolResult({ success: true, skill: params.name, body });
  },
};

export const loadSkillTools = [loadSkillTool];
```

Note: if `z.enum(LOADABLE_SKILLS)` rejects the readonly tuple under this zod version, use
`z.enum([...LOADABLE_SKILLS] as [string, ...string[]])`.

- [ ] **Step 4: Run test + check to verify they pass**

Run: `deno test -A apps/agent/src/common/tools/load-skill_test.ts && deno task check` Expected:
PASS; check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/common/tools/load-skill.ts apps/agent/src/common/tools/load-skill_test.ts
git commit -m "feat(agent): add load_skill tool (on-demand skill bodies)"
```

---

### Task 3: The switch — wire `load_skill`, add skill index, drop boot inlining

**Files:**

- Modify: `apps/agent/src/hmls/system-prompt.ts` (add Skills index)
- Modify: `apps/agent/src/hmls/staff-system-prompt.ts` (add Skills index)
- Modify: `apps/agent/src/hmls/agent.ts` (wire tool, drop boot concat)
- Modify: `apps/agent/src/hmls/staff-agent.ts` (wire tool, drop boot concat)
- Modify: `apps/agent/src/hmls/load-skills.ts` (remove now-unused `loadSkills`)

**Interfaces:**

- Consumes: `loadSkillTools` from `../common/tools/load-skill.ts` (Task 2).

- [ ] **Step 1: Add the Skills index to the customer prompt**

In `apps/agent/src/hmls/system-prompt.ts`, insert this block immediately BEFORE the
`## INTAKE BEHAVIOR — Do This Automatically (CRITICAL)` line:

```ts
## Skills (load before deep work)
Detailed playbooks live in skills you pull on demand with the \`load_skill\` tool. The MOMENT a turn enters one of these areas, call \`load_skill\` FIRST, then act — the body has the full pricing reference / state machine that the rules below only summarize. A loaded skill stays available the rest of the chat; don't reload it.
- \`order\` — pricing & estimates. Load the moment the customer asks "how much / what's it cost", names a service, or describes symptoms needing diagnosis + pricing — BEFORE you price or call create_order.
- \`scheduling\` — booking, rescheduling, cancelling, and the order lifecycle. Load BEFORE you start a booking or move an order's status.
```

- [ ] **Step 2: Add the Skills index to the staff prompt**

In `apps/agent/src/hmls/staff-system-prompt.ts`, insert this block immediately BEFORE the
`## INTAKE BEHAVIOR — Do This Automatically (CRITICAL)` line:

```ts
## Skills (load before deep work)
Detailed playbooks live in skills you pull on demand with the \`load_skill\` tool. The MOMENT the chat enters one of these areas, call \`load_skill\` FIRST, then act — the body has the full pricing reference / state machine the rules below only summarize. A loaded skill stays available the rest of the chat; don't reload it.
- \`order\` — pricing & estimates. Load before pricing a job or calling create_order.
- \`scheduling\` — booking, rescheduling, cancelling, and the order lifecycle/state machine. Load before a booking or a status transition.
```

- [ ] **Step 3: Rewire the customer agent**

In `apps/agent/src/hmls/agent.ts`:

(a) Replace the loader import:

```ts
import { loadSkillTools } from "../common/tools/load-skill.ts";
```

(remove the `import { loadSkills } from "./load-skills.ts";` line)

(b) Remove the boot concat line:

```ts
const SKILLS_PROMISE = loadSkills(["order", "scheduling"]);
```

(c) Replace the system-prompt assembly inside `runHmlsAgent`:

```ts
const parts = [SYSTEM_PROMPT];
if (userContext) parts.push(formatUserContext(userContext));
const systemPrompt = parts.join("\n\n");
```

(remove the `const skills = await SKILLS_PROMISE;` line and the `if (skills) parts.push(skills);`
line)

(d) Add the tool to `allTools` (right after `...askUserQuestionTools,` / `...collectContactTools,`):

```ts
...loadSkillTools,
```

- [ ] **Step 4: Rewire the staff agent**

In `apps/agent/src/hmls/staff-agent.ts`:

(a) Replace the loader import with:

```ts
import { loadSkillTools } from "../common/tools/load-skill.ts";
```

(remove `import { loadSkills } from "./load-skills.ts";`)

(b) Remove `const SKILLS_PROMISE = loadSkills(["order", "scheduling"]);`

(c) Replace the system-prompt assembly:

```ts
const skills = await SKILLS_PROMISE;
const systemPrompt = skills ? `${STAFF_SYSTEM_PROMPT}\n\n${skills}` : STAFF_SYSTEM_PROMPT;
```

with:

```ts
const systemPrompt = STAFF_SYSTEM_PROMPT;
```

(d) Add `...loadSkillTools,` to the staff `allTools` array (after `...askUserQuestionTools,`).

- [ ] **Step 5: Remove the now-unused `loadSkills`**

In `apps/agent/src/hmls/load-skills.ts`, delete the `loadSkills` function (lines from
`/** Read the named skills' bodies...` through its closing brace). Keep `SKILLS_DIR`,
`stripFrontmatter`, `LOADABLE_SKILLS`, `readSkillBody`. Update the file's top comment to describe
the on-demand loader (`readSkillBody` for the `load_skill` tool) instead of boot inlining.

- [ ] **Step 6: Verify the build + existing tests**

Run:
`deno fmt apps/agent/src/hmls/ apps/agent/src/common/tools/ && deno task check && deno task lint && deno task test`
Expected: check clean; lint clean; all tests pass (incl. Task 1/2 tests). Grep to confirm no
stragglers: `grep -rn "loadSkills\b" apps/agent/src` → only the deleted-history, no live references.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/hmls/system-prompt.ts apps/agent/src/hmls/staff-system-prompt.ts apps/agent/src/hmls/agent.ts apps/agent/src/hmls/staff-agent.ts apps/agent/src/hmls/load-skills.ts
git commit -m "feat(agent): switch HMLS agents to on-demand load_skill routing"
```

---

### Task 4: Verify end-to-end (live DeepSeek) + full gate

**Files:** none committed (verification only; delete the scratch script after).

- [ ] **Step 1: Live check — agent calls `load_skill`**

Create a throwaway `apps/agent/src/scripts/_skill-routing-check.ts`:

```ts
import { runHmlsAgent } from "../hmls/agent.ts";

for (const probe of ["2019 Honda civic oil change", "I want to book it for tomorrow"]) {
  const result = await runHmlsAgent({ messages: [{ role: "user", content: probe }] });
  const tools: string[] = [];
  for await (const part of result.fullStream) {
    // deno-lint-ignore no-explicit-any
    const p = part as any;
    if (p.type === "tool-call" && p.toolName) tools.push(p.toolName as string);
  }
  console.log(`"${probe}" -> tools: ${tools.join(", ") || "(none)"}`);
}
Deno.exit(0);
```

Run:
`HMLS_AGENT_MODEL=deepseek-v4-flash infisical run --env=dev -- deno run -A apps/agent/src/scripts/_skill-routing-check.ts`
Expected: the oil-change probe's tool list includes `load_skill` (with `order`); the booking probe
includes `load_skill` (with `scheduling`). If `load_skill` is absent, strengthen the Skills-index
trigger wording in Task 3 Step 1/2 and re-run.

- [ ] **Step 2: Delete the scratch script**

```bash
rm apps/agent/src/scripts/_skill-routing-check.ts
```

- [ ] **Step 3: Confirm the skill body does NOT leak to the customer UI**

Run the local web + customer chat (or inspect `components/chat/tool-cards/index.tsx`): in
`mode="customer"`, `renderToolCard` returns `null` for `load_skill` (not whitelisted), and the
customer chat drops the generic `<Tool>` fallback in customer mode. Confirm no raw skill body
renders in the customer thread. If it does leak, add `load_skill` to the customer-hidden path
(return `null` explicitly) — do NOT show the body.

- [ ] **Step 4: Full local gate**

Run:

```bash
deno task check && deno task lint && deno task fmt:check && deno task test
cd apps/hmls-web && bun run typecheck && bun run lint
```

Expected: all green. (No web code changed, so web test/build are unaffected, but typecheck/lint are
cheap insurance.)

- [ ] **Step 5: Hand off to ship**

Stop here. Ship via the `/ship` flow (PR + CI + Deno Deploy). Rollback if needed = restore the
boot-time `loadSkills([...])` inline in both agents.

---

## Self-Review

- **Spec coverage:** load_skill tool (Task 2) ✓; both agents wired (Task 3) ✓; skill index + spine —
  index added, spine is the prompt's existing pricing/booking sections (kept) ✓; order/scheduling
  on-demand, diagnosis Fixo-only (LOADABLE_SKILLS = 2) ✓; not a stop-point ✓; unit + live tests
  (Tasks 1,2,4) ✓; rollback documented ✓; no web change + no leak (Task 4 Step 3) ✓.
- **Placeholders:** none — every code step has full code.
- **Type consistency:** `LOADABLE_SKILLS` / `readSkillBody` / `loadSkillTools` names match across
  Tasks 1→2→3. `load_skill` tool name matches the prompt index references.
