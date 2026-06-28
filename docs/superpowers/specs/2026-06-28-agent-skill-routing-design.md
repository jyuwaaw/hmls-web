---
title: Dynamic skill routing for the HMLS product agents
date: 2026-06-28
status: approved
---

# Dynamic skill routing (`load_skill`) for the HMLS customer + staff agents

## Problem

The HMLS customer and staff agents each carry a single monolithic system prompt (customer ~303
lines, staff ~124) plus two skill bodies (`order`, `scheduling`) that
`loadSkills(["order","scheduling"])` **inlines at boot — always, every turn**. As behaviors grow
(intake, estimate, scheduling, booking, order management, contact collection) the always-on prompt
splits the model's attention and is harder to maintain. This matters more now that the agents run
DeepSeek `deepseek-v4-flash` (a weaker model is more sensitive to a long, unfocused prompt).

We want **dynamic routing**: load only the relevant skill(s) for the current phase of the
conversation, gstack-style, instead of inlining a fixed set at boot.

## Current state (foundation already exists)

- `apps/agent/.skills/<name>/skill.md` — 7 skill markdowns with YAML frontmatter whose
  `description:` is already phrased as "This skill should be used when…" (order, scheduling, plus
  diagnosis variants used by Fixo).
- `apps/agent/src/hmls/load-skills.ts` — `loadSkills(names)` reads named skill bodies, strips
  frontmatter, concatenates. Called at boot in both `agent.ts` and `staff-agent.ts`.
- Agents are AI SDK v6 `streamText` loops on DeepSeek with a `stopWhen` of
  `[stepCountIs(25), hasToolCall("ask_user_question"), hasToolCall("collect_contact")]`.

## Decision

**Mechanism: an agent-invoked `load_skill` tool.** A thin base prompt carries a **skill index**
(each skill's name + one-line when-to-use, from frontmatter). The agent calls `load_skill('order')`
when the conversation enters that area; the tool returns the skill body as its result, which enters
the conversation context and **persists in message history for the rest of the conversation** (load
once, reused thereafter — no re-load). Chosen over a pre-classifier (extra round-trip per turn) and
a code state-machine (brittle for free-form chat).

**Scope: both the customer and staff agents.** They share the same `.skills/` bodies via
`load_skill` (domain knowledge is agent-agnostic; tone and tool choice stay in each agent's base
prompt).

## Architecture

```
base prompt (always on, thin)
  ├─ Identity, About HMLS, hours, Role
  ├─ Tone & Response Style
  ├─ ask_user_question hard rule (no text options)
  ├─ Customer Context
  ├─ 1–2 line "spine" per domain (graceful-degradation fallback)
  └─ SKILL INDEX: name + when-to-use, one line each
                  ("the moment the customer mentions price/symptoms,
                   call load_skill('order') BEFORE pricing")

load_skill(name) tool
  → reads .skills/<name>/skill.md, strips frontmatter, returns body
  → body lands as a tool result, stays in context across turns
  → NOT a stop-point: agent loads then continues the same turn
```

## Scope of the change (YAGNI)

**v1 moves only the two heavy, already-extracted skills off boot-inlining:**

- Keep in base (always loaded): Identity, About/hours, Role, Tone & Response Style, the
  `ask_user_question` hard rule, Customer Context, **plus the skill index**.
- Convert to on-demand `load_skill`: `order` (pricing / estimate / order creation) and `scheduling`
  (booking / lifecycle). These are the two bodies currently inlined at boot.
- **Do NOT carve new skills (intake, pricing, etc.) in v1** — they stay in base. Carve more only
  after the mechanism is proven, incrementally.

The diagnosis skills (obd/photo/etc.) remain Fixo-only and are not added to the HMLS index in v1.

## `load_skill` tool

- Location: `apps/agent/src/common/tools/load-skill.ts` (shared by both agents).
- Schema: `{ name: z.enum([...known .skills names]) }`. The enum prevents the agent loading a
  non-existent skill.
- `execute`: read `.skills/<name>/skill.md`, strip frontmatter (reuse the existing `load-skills.ts`
  logic, refactored to a single-skill read), return the body via `toolResult`. Unknown/unreadable →
  `toolResult({ success: false })` (defensive; the enum should prevent this).
- `stopWhen`: unchanged — `load_skill` is NOT added to the stop list. The agent loads and continues
  within the same step loop (25-step cap covers load + downstream tool calls).
- Idempotency: re-loading a skill already in context simply returns the body again; harmless. (The
  agent should rarely do this since the body is visible in history.)

## Base-prompt changes

- Both agents: remove the boot-time `loadSkills([...])` concatenation; replace the removed skill
  detail with the **skill index** + a 1–2 line spine per domain.
- Wire `load_skill` into each agent's tool list.
- Update each agent's base prompt to instruct: "When the conversation enters
  <area>, call `load_skill('<name>')` BEFORE acting — the detailed rules live there." Make the
  trigger explicit (the moment price/symptoms come up → load `order`; the moment booking/scheduling
  comes up → load `scheduling`).

## Safety / graceful degradation

- The base prompt keeps a **1–2 line spine** for each domain so a missed/late `load_skill` call
  degrades gracefully instead of failing outright.
- The skill index states the trigger explicitly ("the MOMENT … call load_skill … BEFORE …") to
  minimize the weaker model forgetting or loading late.

## Token reality

Early turns are leaner (only the relevant skill loads). Over a full flow most skills end up loaded,
so total tokens are comparable to today. The win is **attention focus** (sharper
instruction-following, especially on flash) and **extensibility** (new skills don't bloat the base
prompt), not net token savings.

## Testing

- Unit (`load-skill_test.ts`): returns the stripped body for a known skill; errors on an unknown
  name; frontmatter is stripped.
- Live (real DeepSeek, the established verify-against-the-API rule): an oil-change intake leads the
  agent to call `load_skill('order')`; a booking request leads to `load_skill('scheduling')`.
- Existing suites stay green (deno check/lint/test; web typecheck/lint/test/build).

## Rollout

Both agents in one change. Ship via PR + CI + Deno Deploy (the established flow). Roll back =
restore the boot-time `loadSkills([...])` inline (the skill bodies are unchanged; only the loading
mechanism flips).

## Out of scope (deferred)

- Carving intake / pricing / contact into their own skills.
- Adding the diagnosis skills to the HMLS (non-Fixo) index.
- A pre-classifier or any separate routing LLM call.
- Per-shop or per-tenant skill variants.
