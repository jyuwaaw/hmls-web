# Fixo Session & Context Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Fixo from a task-shaped session model (closed diagnostic cases) to a
conversation-shaped one (open-ended chats), add agent-side context summarization, and rebuild the
session UX with vehicle grouping.

**Architecture:** Drop `fixo_sessions.status`/`result`/`completed_at`; add `title`, `summary`,
`last_summarized_message_id`, `last_message_at`, `archived_at`. Move reports to a new `fixo_reports`
table with vehicle + media snapshots. Replace lossy onFinish counter with idempotent
`fixo_message_events` table. Wrap the agent's context build in a `SELECT FOR UPDATE` transaction
with sliding-window summarization via Gemini 2.5 Flash. Frontend gets a sidebar with vehicle
grouping; `/history` is deleted.

**Tech Stack:** Deno workspace, Hono 4, Drizzle 0.45 (postgres-js), AI SDK v6 (`@ai-sdk/google`),
Next.js 16 (fixo-web), Bun, Biome, Tailwind 4, shadcn, SWR.

**Spec:**
[docs/superpowers/specs/2026-05-04-fixo-session-context-management-design.md](docs/superpowers/specs/2026-05-04-fixo-session-context-management-design.md)

---

## Phase 0 — Schema & Migration

The migration is single-PR + single-transaction. It is **not reversible** (the legacy
`result`/`status`/`completed_at` columns are dropped).

### Task 0.1: Update Drizzle schema

**Files:**

- Modify: `packages/shared/src/db/schema.ts:294-313` (fixoSessions definition)
- Modify: `packages/shared/src/db/schema.ts:280-292` (sessionStatusEnum + processingStatusEnum block
  — drop sessionStatusEnum)
- Modify: `packages/shared/src/db/schema.ts:389-396` (exported types)

- [ ] **Step 1: Drop the `sessionStatusEnum` definition.** It is referenced only by
      `fixoSessions.status`, which we are also dropping.

```ts
// REMOVE this block (was around line 280):
export const sessionStatusEnum = pgEnum("fixo_session_status", [...]);
```

- [ ] **Step 2: Replace the `fixoSessions` table definition** with the new shape:

```ts
export const fixoSessions = pgTable(
  "fixo_sessions",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .references(() => customers.id),
    userId: uuid("user_id").references(() => userProfiles.id),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    creditsCharged: integer("credits_charged").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    messages: jsonb("messages"),
    title: text("title"),
    titleIsUserSet: boolean("title_is_user_set").notNull().default(false),
    summary: text("summary"),
    lastSummarizedMessageId: text("last_summarized_message_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_fixo_sessions_customer").on(table.customerId),
    index("idx_fixo_sessions_user_last_msg")
      .on(table.userId, table.lastMessageAt.desc())
      .where(sql`archived_at IS NULL`),
  ],
);
```

Make sure `boolean` is imported from `drizzle-orm/pg-core` (it likely already is — check the
existing imports at top of file).

- [ ] **Step 3: Add the new `fixoReports` table** right after `fixoSessions`:

```ts
export const fixoReports = pgTable(
  "fixo_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    result: jsonb("result").notNull(),
    vehicleSnapshot: jsonb("vehicle_snapshot"),
    mediaSnapshot: jsonb("media_snapshot").notNull().default(sql`'[]'::jsonb`),
    messageCount: integer("message_count").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_fixo_reports_session").on(table.sessionId, table.generatedAt.desc()),
    index("idx_fixo_reports_user").on(table.userId, table.generatedAt.desc()),
  ],
);
```

- [ ] **Step 4: Add the new `fixoMessageEvents` table** right after `fixoReports`:

```ts
export const fixoMessageEvents = pgTable(
  "fixo_message_events",
  {
    userMessageId: text("user_message_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_fixo_msg_events_user_month").on(table.userId, table.month)],
);
```

`date` import from `drizzle-orm/pg-core` may need adding to the imports list.

- [ ] **Step 5: Update `fixoMedia` and `obdCodes` FK definitions** to add `ON DELETE CASCADE`:

```ts
// fixoMedia (around line 319):
sessionId: integer("session_id")
  .notNull()
  .references(() => fixoSessions.id, { onDelete: "cascade" }),

// obdCodes (around line 345):
sessionId: integer("session_id")
  .notNull()
  .references(() => fixoSessions.id, { onDelete: "cascade" }),
```

- [ ] **Step 6: Update the exported types block** at the bottom:

```ts
export type FixoSession = typeof fixoSessions.$inferSelect;
export type NewFixoSession = typeof fixoSessions.$inferInsert;
export type FixoMedia = typeof fixoMedia.$inferSelect;
export type NewFixoMedia = typeof fixoMedia.$inferInsert;
export type ObdCode = typeof obdCodes.$inferSelect;
export type NewObdCode = typeof obdCodes.$inferInsert;
export type FixoEstimate = typeof fixoEstimates.$inferSelect;
export type NewFixoEstimate = typeof fixoEstimates.$inferInsert;
export type FixoReport = typeof fixoReports.$inferSelect;
export type NewFixoReport = typeof fixoReports.$inferInsert;
export type FixoMessageEvent = typeof fixoMessageEvents.$inferSelect;
export type NewFixoMessageEvent = typeof fixoMessageEvents.$inferInsert;
```

- [ ] **Step 7: Run typecheck to verify schema compiles**

```bash
deno task check
```

Expected: PASS. (Other files reference `fixo_sessions.status` / `result` / `completedAt` and will
fail — that's OK and expected. Note them for later phases.)

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/db/schema.ts
git commit -m "schema(fixo): conversation-model fields + reports + message events"
```

### Task 0.2: Hand-write migration 0016_session_b_model.sql

**Files:**

- Create: `apps/agent/migrations/0016_session_b_model.sql`

drizzle-kit's auto-generator cannot produce the backfill logic. Hand-write the file.

- [ ] **Step 1: Create the migration file** with this exact content:

```sql
BEGIN;

-- 1. Create fixo_reports
CREATE TABLE fixo_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  result           jsonb NOT NULL,
  vehicle_snapshot jsonb,
  media_snapshot   jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count    integer NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_reports_session ON fixo_reports(session_id, generated_at DESC);
CREATE INDEX idx_fixo_reports_user    ON fixo_reports(user_id, generated_at DESC);

-- 2. Create fixo_message_events (idempotent quota counter)
CREATE TABLE fixo_message_events (
  user_message_id text  PRIMARY KEY,
  user_id         uuid  NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  month           date  NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_msg_events_user_month ON fixo_message_events(user_id, month);

-- 3. Alter dependent FKs to CASCADE so DELETE /sessions can rely on a single
--    DELETE FROM fixo_sessions wiping dependents.
ALTER TABLE fixo_media
  DROP CONSTRAINT fixo_media_session_id_fixo_sessions_id_fk,
  ADD CONSTRAINT  fixo_media_session_id_fixo_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES fixo_sessions(id) ON DELETE CASCADE;

ALTER TABLE fixo_obd_codes
  DROP CONSTRAINT fixo_obd_codes_session_id_fixo_sessions_id_fk,
  ADD CONSTRAINT  fixo_obd_codes_session_id_fixo_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES fixo_sessions(id) ON DELETE CASCADE;

-- (fixo_estimates intentionally keeps ON DELETE SET NULL — estimates outlive
-- their source session.)

-- 4. Backfill reports from existing fixo_sessions.result.
--    D2 (decision, 2026-05-04): legacy customer-only sessions are NOT migrated.
--    There is no production user base; preserving customer_id-only records would
--    permanently complicate the SaaS-targeted schema for zero real value.
INSERT INTO fixo_reports (
  session_id, user_id, result, vehicle_snapshot, media_snapshot,
  message_count, generated_at
)
SELECT
  s.id,
  s.user_id,
  s.result,
  to_jsonb(v.*),
  COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'type', m.type,
        'storageKey', m.r2_key,
        'transcription', m.transcription,
        'createdAt', m.created_at
      ))
      FROM fixo_media m WHERE m.session_id = s.id
    ),
    '[]'::jsonb
  ),
  COALESCE(jsonb_array_length(s.messages), 0),
  COALESCE(s.completed_at, s.created_at)
FROM fixo_sessions s
LEFT JOIN vehicles v ON v.id = s.vehicle_id
WHERE s.result IS NOT NULL AND s.user_id IS NOT NULL;

-- 5. Add new columns to fixo_sessions
ALTER TABLE fixo_sessions
  ADD COLUMN title text,
  ADD COLUMN title_is_user_set boolean NOT NULL DEFAULT false,
  ADD COLUMN summary text,
  ADD COLUMN last_summarized_message_id text,
  ADD COLUMN last_message_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN archived_at timestamptz;

-- 6. Backfill last_message_at from messages array (fallback to created_at)
UPDATE fixo_sessions
SET last_message_at = COALESCE(
  (
    SELECT MAX( (msg->>'createdAt')::timestamptz )
    FROM jsonb_array_elements(messages) AS msg
    WHERE msg->>'createdAt' IS NOT NULL
  ),
  created_at
);

-- 7. Backfill titles from first user message text part
UPDATE fixo_sessions
SET title = LEFT(
  COALESCE(
    (
      SELECT (part->>'text')
      FROM jsonb_array_elements(messages->0->'parts') AS part
      WHERE part->>'type' = 'text' AND part->>'text' IS NOT NULL
      LIMIT 1
    ),
    'Untitled diagnosis'
  ),
  40
)
WHERE title IS NULL;

-- 8. Drop legacy columns + enum
ALTER TABLE fixo_sessions
  DROP COLUMN result,
  DROP COLUMN status,
  DROP COLUMN completed_at;
DROP TYPE fixo_session_status;

-- 9. Index for the new sort/filter pattern
CREATE INDEX idx_fixo_sessions_user_last_msg
  ON fixo_sessions (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
```

- [ ] **Step 2: Verify migration filename + journal entry**

drizzle-kit's journal is at `apps/agent/migrations/meta/_journal.json`. Hand-edit to add the new
entry. Look at the most recent existing entry's shape and clone it, bumping `idx` and changing `tag`
to `0016_session_b_model`.

```bash
cat apps/agent/migrations/meta/_journal.json | tail -20
```

Add this entry to the `entries` array (with appropriate when timestamp = unix ms now):

```json
{
  "idx": <next-idx>,
  "version": "<copy from previous entry>",
  "when": <unix ms>,
  "tag": "0016_session_b_model",
  "breakpoints": true
}
```

- [ ] **Step 3: Apply migration to dev DB**

```bash
infisical run --env=dev -- deno task --cwd apps/agent db:migrate
```

Expected: "applied migration 0016_session_b_model" with no errors.

- [ ] **Step 4: Verify schema in DB matches**

```bash
infisical run --env=dev -- deno task --cwd apps/agent db:studio
```

In the GUI: confirm `fixo_reports` and `fixo_message_events` tables exist; `fixo_sessions` has
`title`, `last_message_at`, etc; no `status` / `result` / `completed_at` columns;
`fixo_session_status` enum is gone.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/migrations/0016_session_b_model.sql apps/agent/migrations/meta/_journal.json
git commit -m "db(fixo): migration 0016 — sessions become conversations"
```

---

## Phase 1 — Agent context management

Build the new `buildAgentContext` + summarizer. Phase ends with `runFixoAgent` accepting a pre-built
systemPrompt; nothing in the gateway calls the new helpers yet (Phase 2 wires them).

### Task 1.1: Token estimator

**Files:**

- Create: `apps/agent/src/fixo/token-estimate.ts`
- Test: `apps/agent/src/fixo/token-estimate_test.ts`

A shared, runtime-safe token estimator. Phase pick: just the chars/3.5 fallback for now — wire a
real tokenizer in a follow-up if metrics show drift. The `fixo.compact.estimator.degraded` log will
fire on every call for now so we know.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/src/fixo/token-estimate_test.ts
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateTokens } from "./token-estimate.ts";
import type { ModelMessage } from "ai";

Deno.test("estimateTokens — empty array", () => {
  assertEquals(estimateTokens([]), 0);
});

Deno.test("estimateTokens — single text message", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "hello world" }, // 11 chars
  ];
  // chars/3.5 → ~3
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
  // 10 chars in stringified output
  const result = estimateTokens(messages);
  assertAlmostEquals(result, Math.ceil(10 / 3.5), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
deno test apps/agent/src/fixo/token-estimate_test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/agent/src/fixo/token-estimate.ts
import type { ModelMessage } from "ai";

const CHARS_PER_TOKEN_FALLBACK = 3.5;

/**
 * Approximate input-token count for a sequence of ModelMessages.
 *
 * Today: chars/3.5 fallback (slightly more conservative than the standard /4).
 * Sufficient for compaction triggering decisions; not for billing. Plan-phase
 * follow-up will swap in a real tokenizer (Gemini count_tokens REST or
 * js-tiktoken cl100k_base) once we measure drift in production.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === "text") {
        chars += part.text.length;
      } else if ("output" in part && part.output) {
        chars += JSON.stringify(part.output).length;
      } else if ("input" in part && part.input) {
        chars += JSON.stringify(part.input).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_FALLBACK);
}

export function estimateTokensInString(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN_FALLBACK);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
deno test apps/agent/src/fixo/token-estimate_test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/fixo/token-estimate.ts apps/agent/src/fixo/token-estimate_test.ts
git commit -m "feat(fixo-agent): chars/3.5 token estimator with multipart support"
```

### Task 1.2: Summarizer

**Files:**

- Create: `apps/agent/src/fixo/summarizer.ts`

The summarizer takes UIMessages-to-fold + a previous summary (possibly null), returns a new
rolled-up text summary. We do NOT add a unit test that calls Gemini — that's an integration concern.
Instead we test the prompt construction.

- [ ] **Step 1: Implement**

```ts
// apps/agent/src/fixo/summarizer.ts
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getLogger } from "@logtape/logtape";
import type { UIMessage } from "ai";

const logger = getLogger(["hmls", "agent", "fixo", "summarizer"]);

export const SUMMARIZER_MODEL = "gemini-2.5-flash";

const SUMMARIZER_SYSTEM = `You are a context compactor for Fixo, a car-diagnosis assistant. Fold the
following conversation into the existing "Known facts" memo. Preserve:

1. Vehicle (year/make/model/mileage/VIN if mentioned)
2. Symptoms (what the user described, when, conditions)
3. OBD codes seen (with their resolved meaning if looked up)
4. Tools called and their key outputs (labor times, parts, severity)
5. Hypotheses confirmed or ruled out
6. Pending questions the assistant asked but user hasn't answered
7. Uploaded evidence — for each photo / audio / video the user uploaded,
   keep a one-sentence factual description of what it showed (e.g. "photo
   of dashboard with check-engine light + ABS light on", "20-second engine
   recording with rhythmic knocking at idle"). Include the media id so
   later turns can re-reference. Do NOT drop these — they are why the
   diagnosis exists.

Drop:
- Greetings, filler, restated questions
- Tool call mechanics (just keep the answer)
- Verbatim signed-URL strings (re-hydrated separately every turn)

Output: one terse markdown bullet list under 800 tokens. No prose.`;

export interface RunSummarizerOptions {
  previousSummary: string | null;
  messagesToFold: UIMessage[];
}

export async function runSummarizer(
  opts: RunSummarizerOptions,
): Promise<string> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY required for summarizer");

  const transcript = serializeForSummarizer(opts.messagesToFold);
  const prompt = opts.previousSummary
    ? `EXISTING MEMO:\n${opts.previousSummary}\n\nNEW CONVERSATION TO FOLD IN:\n${transcript}`
    : `CONVERSATION:\n${transcript}`;

  const google = createGoogleGenerativeAI({ apiKey });
  const start = Date.now();
  const { text } = await generateText({
    model: google(SUMMARIZER_MODEL),
    system: SUMMARIZER_SYSTEM,
    prompt,
  });
  logger.info("Summarizer complete", {
    durationMs: Date.now() - start,
    foldedCount: opts.messagesToFold.length,
    outputLen: text.length,
  });
  return text.trim();
}

/**
 * Render UIMessages as plain-text-ish input for the summarizer. Includes
 * media references with their ids so the summarizer can keep pointers.
 */
function serializeForSummarizer(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const prefix = m.role === "user"
      ? "USER"
      : m.role === "assistant"
      ? "ASSISTANT"
      : m.role.toUpperCase();
    for (const part of m.parts) {
      if (part.type === "text") {
        lines.push(`${prefix}: ${part.text}`);
      } else if (part.type === "file") {
        const mediaType = (part as { mediaType?: string }).mediaType ?? "file";
        const id = (part as { id?: string }).id ?? "(no id)";
        lines.push(`${prefix}: [uploaded ${mediaType}, media_id=${id}]`);
      } else if ("toolName" in part) {
        const tn = (part as { toolName?: string }).toolName;
        const output = (part as { output?: unknown }).output;
        if (output !== undefined) {
          lines.push(`TOOL[${tn}]: ${JSON.stringify(output).slice(0, 500)}`);
        }
      }
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 2: Add summarizer export to `apps/agent/src/mod.ts`** if not already exported:

```ts
// apps/agent/src/mod.ts
export { runSummarizer } from "./fixo/summarizer.ts";
```

- [ ] **Step 3: Typecheck**

```bash
deno task check
```

Expected: PASS for new file. (Other unrelated errors from Phase 0 dropped columns are still expected
— note them.)

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/fixo/summarizer.ts apps/agent/src/mod.ts
git commit -m "feat(fixo-agent): summarizer (Gemini 2.5 Flash) preserving media"
```

### Task 1.3: buildAgentContext

**Files:**

- Create: `apps/agent/src/fixo/build-context.ts`
- Test: `apps/agent/src/fixo/build-context_test.ts`

This is the heart of context management — the function that decides whether to summarize and
assembles `(systemPrompt, modelMessages)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/src/fixo/build-context_test.ts
import { assertEquals } from "@std/assert";
import { findCursorIndex } from "./build-context.ts";
import type { UIMessage } from "ai";

const mk = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
} as UIMessage);

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
```

- [ ] **Step 2: Run test, verify fail**

```bash
deno test apps/agent/src/fixo/build-context_test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/agent/src/fixo/build-context.ts
import type { ModelMessage, UIMessage } from "ai";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { estimateTokens, estimateTokensInString } from "./token-estimate.ts";
import { runSummarizer } from "./summarizer.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

const logger = getLogger(["hmls", "agent", "fixo", "context"]);

export const COMPACT_THRESHOLD = 30_000;
export const KEEP_RECENT_COUNT = 12;

export interface BuildAgentContextOptions {
  sessionId: number;
  latestMessages: ModelMessage[];
  uiMessages: UIMessage[];
}

export interface AgentContext {
  systemPrompt: string;
  modelMessages: ModelMessage[];
}

/**
 * Locate the index AFTER the message whose id matches `markerId`.
 * Returns 0 when markerId is null or the marker isn't found in the array.
 * Exported for testability.
 */
export function findCursorIndex(uiMessages: UIMessage[], markerId: string | null): number {
  if (markerId === null) return 0;
  for (let i = 0; i < uiMessages.length; i++) {
    if (uiMessages[i].id === markerId) return i + 1;
  }
  // Marker not found — treat as fresh start. The session row's message
  // history may have been edited; refolding from scratch is safer than
  // skipping unknowable content.
  logger.warn("summary cursor marker not found in current message array", {
    markerId,
    messageCount: uiMessages.length,
  });
  return 0;
}

/**
 * Build agent context (systemPrompt + windowed modelMessages) for a Fixo turn.
 *
 * The whole body runs inside one transaction with `SELECT ... FOR UPDATE` on
 * the session row. This serializes concurrent /task or /compact callers so
 * `summary` and `last_summarized_message_id` cannot drift apart. Cost: a few
 * seconds of serialization tail when summarization triggers, dominated by the
 * Gemini 2.5 Flash call (~1-3s).
 */
export async function buildAgentContext(
  opts: BuildAgentContextOptions,
): Promise<AgentContext> {
  return await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        summary: schema.fixoSessions.summary,
        lastSummarizedMessageId: schema.fixoSessions.lastSummarizedMessageId,
      })
      .from(schema.fixoSessions)
      .where(eq(schema.fixoSessions.id, opts.sessionId))
      .for("update")
      .limit(1);

    if (!session) {
      // Session disappeared mid-flight (delete race?). Fall back to no-summary.
      return {
        systemPrompt: SYSTEM_PROMPT,
        modelMessages: opts.latestMessages.slice(-KEEP_RECENT_COUNT),
      };
    }

    const cursorIndex = findCursorIndex(opts.uiMessages, session.lastSummarizedMessageId);
    const unsummarized = opts.uiMessages.slice(cursorIndex);

    const summaryTokens = estimateTokensInString(session.summary);
    const unsummarizedTokens = estimateTokens(opts.latestMessages.slice(cursorIndex));
    const estimatedTotal = summaryTokens + unsummarizedTokens;

    let summary: string | null = session.summary ?? null;
    const shouldSummarize = estimatedTotal > COMPACT_THRESHOLD ||
      unsummarized.length > KEEP_RECENT_COUNT * 2;

    if (shouldSummarize) {
      const foldEnd = unsummarized.length - KEEP_RECENT_COUNT;
      const messagesToFold = unsummarized.slice(0, Math.max(0, foldEnd));
      if (messagesToFold.length > 0) {
        const before = estimatedTotal;
        try {
          summary = await runSummarizer({
            previousSummary: summary,
            messagesToFold,
          });
          const lastFolded = messagesToFold[messagesToFold.length - 1];
          await tx
            .update(schema.fixoSessions)
            .set({
              summary,
              lastSummarizedMessageId: lastFolded.id,
            })
            .where(eq(schema.fixoSessions.id, opts.sessionId));

          const after = estimateTokensInString(summary) +
            estimateTokens(opts.latestMessages.slice(-KEEP_RECENT_COUNT));
          logger.info("fixo.compact.triggered", {
            sessionId: opts.sessionId,
            messagesFolded: messagesToFold.length,
            beforeTokens: before,
            afterTokens: after,
          });
        } catch (err) {
          // Summarizer failure: log + fall through with un-summarized context
          // for this turn. Next turn retries.
          logger.warn("Summarizer failed; falling back to un-windowed context", {
            sessionId: opts.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const systemPrompt = summary
      ? `${SYSTEM_PROMPT}\n\n## Known facts so far\n${summary}`
      : SYSTEM_PROMPT;

    return {
      systemPrompt,
      modelMessages: opts.latestMessages.slice(-KEEP_RECENT_COUNT),
    };
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
deno test apps/agent/src/fixo/build-context_test.ts
```

Expected: PASS (3 tests). The full transactional path is exercised in Phase 2's integration tests.

- [ ] **Step 5: Add export to mod.ts**

```ts
// apps/agent/src/mod.ts
export { buildAgentContext } from "./fixo/build-context.ts";
```

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/fixo/build-context.ts apps/agent/src/fixo/build-context_test.ts apps/agent/src/mod.ts
git commit -m "feat(fixo-agent): buildAgentContext with FOR UPDATE summarization"
```

### Task 1.4: runFixoAgent accepts pre-built systemPrompt

**Files:**

- Modify: `apps/agent/src/fixo/agent.ts:17-71`

- [ ] **Step 1: Modify runFixoAgent signature** to take an optional `systemPrompt`. Replace the
      existing `RunFixoAgentOptions` interface and the `streamText` call:

```ts
export interface RunFixoAgentOptions {
  messages: ModelMessage[];
  userId?: string;
  /** When provided, overrides the constant SYSTEM_PROMPT. Used by the gateway
   * after buildAgentContext attaches a "Known facts so far" summary. */
  systemPrompt?: string;
}

export function runFixoAgent(options: RunFixoAgentOptions) {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required");
  }

  const modelId = Deno.env.get("AGENT_MODEL") || DEFAULT_MODEL;
  const google = createGoogleGenerativeAI({ apiKey });

  const allTools: LegacyTool[] = [
    extractVideoFramesTool,
    lookupObdCodeTool,
    ...askUserQuestionTools,
    ...laborLookupTools,
    ...partsLookupTools,
    createFixoEstimateTool,
  ];

  const tools = convertTools(allTools, { userId: options.userId });
  logger.info("Initializing Fixo agent", {
    model: modelId,
    toolCount: Object.keys(tools).length,
    hasInjectedSummary: typeof options.systemPrompt === "string",
  });

  return streamText({
    model: google(modelId),
    system: options.systemPrompt ?? SYSTEM_PROMPT,
    messages: options.messages,
    tools,
    stopWhen: [stepCountIs(10), hasToolCall("ask_user_question")],
    onStepFinish: (step) => {
      const toolCalls = step.toolCalls ?? [];
      if (toolCalls.length > 0) {
        logger.debug("Step tool calls", {
          toolNames: toolCalls.map((t) => t.toolName),
        });
      }
      if (step.finishReason && step.finishReason !== "tool-calls") {
        logger.info("Agent step finished", {
          finishReason: step.finishReason,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
        });
      }
    },
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
deno task check:agent
```

Expected: PASS (only Phase 0 unrelated errors remain).

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/fixo/agent.ts
git commit -m "refactor(fixo-agent): runFixoAgent accepts injected systemPrompt"
```

---

## Phase 2 — Gateway routes

### Task 2.1: Rewrite tier middleware

**Files:**

- Modify: `apps/gateway/src/middleware/fixo/tier.ts` (full rewrite)

The original `checkFreeTierLimit` conflated text-quota, media-quota, and the legacy
"exclude-this-session-id" hack. Split into three orthogonal functions.

- [ ] **Step 1: Replace the file content**

```ts
// apps/gateway/src/middleware/fixo/tier.ts
import { db, schema } from "@hmls/agent/db";
import { and, count, eq, gte } from "drizzle-orm";
import type { AuthContext } from "./auth.ts";

const FREE_LIMITS = {
  userMessagesPerMonth: 5,
  reportsPerMonth: 1,
} as const;

function monthStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function monthDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function requireTextQuota(auth: AuthContext): Promise<Response | null> {
  if (auth.tier === "plus") return null;

  const month = monthDateString();
  const [{ value }] = await db
    .select({ value: count() })
    .from(schema.fixoMessageEvents)
    .where(
      and(
        eq(schema.fixoMessageEvents.userId, auth.userId),
        eq(schema.fixoMessageEvents.month, month),
      ),
    );

  if (Number(value) >= FREE_LIMITS.userMessagesPerMonth) {
    return new Response(
      JSON.stringify({
        error: "limit_reached",
        message:
          `Free plan limit reached (${FREE_LIMITS.userMessagesPerMonth} messages/month). Upgrade to Plus for unlimited chat.`,
        usage: { used: Number(value), limit: FREE_LIMITS.userMessagesPerMonth },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

export async function requireReportQuota(auth: AuthContext): Promise<Response | null> {
  if (auth.tier === "plus") return null;

  const start = monthStart();
  const [{ value }] = await db
    .select({ value: count() })
    .from(schema.fixoReports)
    .where(
      and(
        eq(schema.fixoReports.userId, auth.userId),
        gte(schema.fixoReports.generatedAt, start),
      ),
    );

  if (Number(value) >= FREE_LIMITS.reportsPerMonth) {
    return new Response(
      JSON.stringify({
        error: "limit_reached",
        message:
          `Free plan limit reached (${FREE_LIMITS.reportsPerMonth} report/month). Upgrade to Plus for unlimited reports.`,
        usage: { used: Number(value), limit: FREE_LIMITS.reportsPerMonth },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

export function requireMediaTier(auth: AuthContext): Response | null {
  if (auth.tier === "plus") return null;
  return new Response(
    JSON.stringify({
      error: "upgrade_required",
      message: "Upgrade to Plus to use photo, audio, video, and OBD diagnostics",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}
```

- [ ] **Step 2: Update consumers (Phase 2 will keep doing this as we touch each route)**

For now, leave existing call sites broken — they reference `checkFreeTierLimit`. The next tasks fix
each call site. Typecheck will fail — that's expected.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/middleware/fixo/tier.ts
git commit -m "refactor(fixo-gateway): split tier check into 3 orthogonal gates"
```

### Task 2.2: Rewrite POST /task — eager session, idempotent counter, buildAgentContext

**Files:**

- Modify: `apps/gateway/src/routes/fixo/chat.ts` (significant rewrite)

The current chat.ts:

1. Doesn't eagerly create sessions (deferred to client).
2. Counts via lossy onFinish.
3. Has no context management.
4. Calls reopenIfComplete (gone in this refactor).

Replace with:

- [ ] **Step 1: Rewrite the file**

```ts
// apps/gateway/src/routes/fixo/chat.ts
import { Hono } from "hono";
import { convertToModelMessages, generateText, type UIMessage } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { buildAgentContext, runFixoAgent } from "@hmls/agent";
import { requireTextQuota } from "../../middleware/fixo/tier.ts";
import { getLogger } from "@logtape/logtape";
import { db, schema } from "@hmls/agent/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { hydrateSessionMedia } from "./lib/hydrate-media.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "chat"]);

type Variables = { auth: AuthContext };

const chat = new Hono<{ Variables: Variables }>();

chat.post("/", async (c) => {
  const auth = c.get("auth");

  let body: { messages?: UIMessage[]; sessionId?: number | string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  const parsedSessionId = typeof body.sessionId === "string"
    ? parseInt(body.sessionId)
    : typeof body.sessionId === "number"
    ? body.sessionId
    : null;

  if (parsedSessionId === null || !Number.isInteger(parsedSessionId)) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (!latestUserMessage) {
    return c.json({ error: "no user message in payload" }, 400);
  }

  // 1. Idempotent counter insert. ON CONFLICT DO NOTHING means client retries
  //    do not double-count the same UIMessage.id.
  const [inserted] = await db
    .insert(schema.fixoMessageEvents)
    .values({
      userMessageId: latestUserMessage.id,
      userId: auth.userId,
      sessionId: parsedSessionId,
      month: monthDate(),
    })
    .onConflictDoNothing({ target: schema.fixoMessageEvents.userMessageId })
    .returning({ userMessageId: schema.fixoMessageEvents.userMessageId });
  const isNewMessage = !!inserted;

  // 2. Quota check ONLY for new messages — replays/retries skip the gate.
  if (isNewMessage) {
    const tierBlock = await requireTextQuota(auth);
    if (tierBlock) {
      // Roll back the insert so the user isn't charged a quota slot they
      // can't use.
      await db
        .delete(schema.fixoMessageEvents)
        .where(eq(schema.fixoMessageEvents.userMessageId, latestUserMessage.id));
      return tierBlock;
    }
  }

  const startTime = Date.now();
  const messageCount = messages.length;
  logger.info("Request received", {
    userId: auth.userId,
    messageCount,
    sessionId: parsedSessionId,
    isNewMessage,
  });

  try {
    const originalMessages: UIMessage[] = structuredClone(messages);

    const attachedMedia = await hydrateSessionMedia(
      messages,
      parsedSessionId,
      auth.userId,
      auth.customerId,
    );
    if (attachedMedia > 0) {
      logger.info("Hydrated session media", { sessionId: parsedSessionId, attachedMedia });
    }

    const latestMessages = await convertToModelMessages(messages);
    const { systemPrompt, modelMessages } = await buildAgentContext({
      sessionId: parsedSessionId,
      latestMessages,
      uiMessages: messages,
    });

    const result = runFixoAgent({
      messages: modelMessages,
      systemPrompt,
      userId: auth.userId,
    });

    const response = result.toUIMessageStreamResponse({
      originalMessages,
      onFinish: ({ messages: finalMessages }) => {
        // Persist transcript + bump last_message_at + maybe trigger title gen.
        // All fire-and-forget — failure logs but does not delay stream close.
        db
          .update(schema.fixoSessions)
          .set({
            messages: finalMessages,
            lastMessageAt: new Date(),
          })
          .where(
            and(
              eq(schema.fixoSessions.id, parsedSessionId),
              ownerPredicate(auth),
            ),
          )
          .catch((err: unknown) => {
            logger.warn("Failed to persist transcript", {
              sessionId: parsedSessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

        maybeGenerateTitle(parsedSessionId, finalMessages, auth);
      },
    });

    logger.info("Request finished", {
      userId: auth.userId,
      messageCount,
      duration: Date.now() - startTime,
      attachedMedia,
    });
    return response;
  } catch (error) {
    logger.error("Agent failed", {
      userId: auth.userId,
      messageCount,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

function monthDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function ownerPredicate(auth: AuthContext) {
  return auth.customerId !== undefined
    ? sql`(${schema.fixoSessions.userId} = ${auth.userId} OR ${schema.fixoSessions.customerId} = ${auth.customerId})`
    : eq(schema.fixoSessions.userId, auth.userId);
}

/**
 * Fire-and-forget title generator. Triggered after the FIRST assistant turn.
 * Race-safe via WHERE clause: title IS NULL AND title_is_user_set = false.
 */
function maybeGenerateTitle(
  sessionId: number,
  finalMessages: UIMessage[],
  auth: AuthContext,
): void {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) return;

  const userMsg = finalMessages.find((m) => m.role === "user");
  const assistantMsg = finalMessages.find((m) => m.role === "assistant");
  if (!userMsg || !assistantMsg) return;

  const preview = (userMsg.parts.find((p) => p.type === "text") as { text?: string } | undefined)
    ?.text;
  if (!preview) return;

  const google = createGoogleGenerativeAI({ apiKey });
  generateText({
    model: google("gemini-2.5-flash"),
    prompt:
      `Summarize this car-diagnosis conversation as a 4-6 word title. No quotes, no period.\n\nConversation:\n${
        preview.slice(0, 500)
      }`,
  })
    .then(({ text }) =>
      db.update(schema.fixoSessions)
        .set({ title: text.trim() })
        .where(
          and(
            eq(schema.fixoSessions.id, sessionId),
            isNull(schema.fixoSessions.title),
            eq(schema.fixoSessions.titleIsUserSet, false),
            ownerPredicate(auth),
          ),
        )
    )
    .catch((err) => logger.warn("title generation failed", { sessionId, err }));
}

export { chat };
```

- [ ] **Step 2: Update existing tests**

The existing `apps/gateway/src/routes/fixo/chat_test.ts` tests the previous reopen flow. Walk
through it; remove tests that assert reopen behavior; keep / update tests that verify error paths
and basic invocation.

- [ ] **Step 3: Add new test**

```ts
// apps/gateway/src/routes/fixo/chat_test.ts (append)
Deno.test("POST /task — same user_message_id twice does not double-count", async () => {
  // Setup: create a free-tier user, a session, post a message with id "msg-1".
  // Post again with the same id. Assert fixo_message_events has exactly 1 row.
  // (Use the existing test bootstrap pattern; mirror chat_test.ts setup.)
  // ...details to be filled in by an engineer reading this — mirror existing
  // patterns in the file. Key assertions:
  //   - First call: 200, fixo_message_events count = 1
  //   - Second call (same id): 200, fixo_message_events count = 1
});
```

- [ ] **Step 4: Run typecheck on gateway**

```bash
deno task check:gateway
```

Some Phase 0 errors will still appear from other files. New errors specific to chat.ts should be
zero.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/fixo/chat.ts apps/gateway/src/routes/fixo/chat_test.ts
git commit -m "feat(fixo-gateway): /task with idempotent counter + buildAgentContext"
```

### Task 2.3: Sessions CRUD — PATCH, DELETE, list filter, /reports, /compact

**Files:**

- Modify: `apps/gateway/src/routes/fixo/sessions.ts` (full rewrite)
- Modify: `apps/gateway/src/routes/fixo/lib/hydrate-media.ts` — only if storage_key reference is
  wrong

- [ ] **Step 1: Rewrite sessions.ts**

```ts
// apps/gateway/src/routes/fixo/sessions.ts
import { Hono } from "hono";
import { db, schema } from "@hmls/agent/db";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { createClient } from "npm:@supabase/supabase-js@^2.99.1";
import { buildAgentContext } from "@hmls/agent";
import { runSummarizer } from "@hmls/agent";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "sessions"]);

type Variables = { auth: AuthContext };
const sessions = new Hono<{ Variables: Variables }>();

function ownerPredicate(auth: AuthContext) {
  return auth.customerId !== undefined
    ? or(
      eq(schema.fixoSessions.userId, auth.userId),
      eq(schema.fixoSessions.customerId, auth.customerId),
    )
    : eq(schema.fixoSessions.userId, auth.userId);
}

// POST / — create empty session
sessions.post("/", async (c) => {
  const auth = c.get("auth");
  const [session] = await db
    .insert(schema.fixoSessions)
    .values({
      userId: auth.userId,
      customerId: auth.customerId ?? null,
    })
    .returning();
  return c.json({ sessionId: session.id });
});

// GET / — list, default excludes archived
sessions.get("/", async (c) => {
  const auth = c.get("auth");
  const includeArchived = c.req.query("include_archived") === "true";

  const conditions = [ownerPredicate(auth)];
  if (!includeArchived) conditions.push(isNull(schema.fixoSessions.archivedAt));

  const rows = await db
    .select({
      id: schema.fixoSessions.id,
      title: schema.fixoSessions.title,
      vehicleId: schema.fixoSessions.vehicleId,
      lastMessageAt: schema.fixoSessions.lastMessageAt,
      createdAt: schema.fixoSessions.createdAt,
      archivedAt: schema.fixoSessions.archivedAt,
    })
    .from(schema.fixoSessions)
    .where(and(...conditions))
    .orderBy(desc(schema.fixoSessions.lastMessageAt));

  return c.json({ sessions: rows });
});

// GET /:id — full detail
sessions.get("/:id", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const [session] = await db
    .select()
    .from(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .limit(1);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const media = await db
    .select()
    .from(schema.fixoMedia)
    .where(eq(schema.fixoMedia.sessionId, id));
  const codes = await db
    .select()
    .from(schema.obdCodes)
    .where(eq(schema.obdCodes.sessionId, id));

  return c.json({ session, media, codes });
});

// PATCH /:id — rename / archive / unarchive
const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  archivedAt: z.union([z.string().datetime(), z.null()]).optional(),
});

sessions.patch("/:id", zValidator("json", patchSchema), async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const body = c.req.valid("json");
  const update: Partial<typeof schema.fixoSessions.$inferInsert> = {};
  if (body.title !== undefined) {
    update.title = body.title;
    update.titleIsUserSet = true;
  }
  if (body.archivedAt !== undefined) {
    update.archivedAt = body.archivedAt === null ? null : new Date(body.archivedAt);
  }
  if (Object.keys(update).length === 0) return c.json({ error: "nothing to update" }, 400);

  const [updated] = await db
    .update(schema.fixoSessions)
    .set(update)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ session: updated });
});

// DELETE /:id — hard delete + storage cleanup
sessions.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  // 1. collect storage keys before cascade wipes them
  const mediaRows = await db
    .select({ storageKey: schema.fixoMedia.storageKey })
    .from(schema.fixoMedia)
    .where(eq(schema.fixoMedia.sessionId, id));

  // 2. cascade delete via session row
  const deleted = await db
    .delete(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .returning({ id: schema.fixoSessions.id });
  if (deleted.length === 0) return c.json({ error: "Session not found" }, 404);

  // 3. best-effort storage cleanup
  if (mediaRows.length > 0) {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (url && serviceKey) {
      const supabase = createClient(url, serviceKey);
      const keys = mediaRows.map((m) => m.storageKey);
      // Bucket name lives elsewhere — read existing media routes for the
      // exact constant. (See apps/gateway/src/routes/fixo/input.ts.)
      const bucket = Deno.env.get("FIXO_MEDIA_BUCKET") ?? "fixo-media";
      const { error } = await supabase.storage.from(bucket).remove(keys);
      if (error) {
        logger.warn("Storage cleanup failed (non-blocking)", {
          sessionId: id,
          keyCount: keys.length,
          error: error.message,
        });
      }
    }
  }
  return c.json({ deleted: true });
});

// GET /:id/reports — list report snapshots for this session
sessions.get("/:id/reports", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  // Verify ownership through the session
  const [session] = await db
    .select({ id: schema.fixoSessions.id })
    .from(schema.fixoSessions)
    .where(and(eq(schema.fixoSessions.id, id), ownerPredicate(auth)))
    .limit(1);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const reports = await db
    .select({
      id: schema.fixoReports.id,
      messageCount: schema.fixoReports.messageCount,
      generatedAt: schema.fixoReports.generatedAt,
      severity: sql<string | null>`${schema.fixoReports.result}->>'overallSeverity'`,
      summary: sql<string | null>`${schema.fixoReports.result}->>'summary'`,
    })
    .from(schema.fixoReports)
    .where(eq(schema.fixoReports.sessionId, id))
    .orderBy(desc(schema.fixoReports.generatedAt));
  return c.json({ reports });
});

// POST /:id/compact — manual context compaction
sessions.post("/:id/compact", async (c) => {
  const auth = c.get("auth");
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);

  const [session] = await db
    .select({
      messages: schema.fixoSessions.messages,
      summary: schema.fixoSessions.summary,
      lastSummarizedMessageId: schema.fixoSessions.lastSummarizedMessageId,
      userId: schema.fixoSessions.userId,
      customerId: schema.fixoSessions.customerId,
    })
    .from(schema.fixoSessions)
    .where(eq(schema.fixoSessions.id, id))
    .limit(1);

  if (
    !session ||
    (session.userId !== auth.userId && session.customerId !== auth.customerId)
  ) {
    return c.json({ error: "Session not found" }, 404);
  }

  const allMessages = (session.messages ?? []) as Array<{ id: string }>;
  if (allMessages.length === 0) {
    return c.json({ error: "session has no messages to compact" }, 400);
  }

  // Force fold everything except the last KEEP_RECENT_COUNT raw messages.
  // Logic mirrors buildAgentContext but without the threshold gate.
  const KEEP_RECENT_COUNT = 12;
  const cursorIndex = session.lastSummarizedMessageId
    ? allMessages.findIndex((m) => m.id === session.lastSummarizedMessageId) + 1
    : 0;
  const unsummarized = allMessages.slice(Math.max(0, cursorIndex));
  const messagesToFold = unsummarized.slice(
    0,
    Math.max(0, unsummarized.length - KEEP_RECENT_COUNT),
  );
  if (messagesToFold.length === 0) {
    return c.json({ message: "nothing to compact", summary: session.summary });
  }

  const newSummary = await runSummarizer({
    previousSummary: session.summary ?? null,
    // deno-lint-ignore no-explicit-any
    messagesToFold: messagesToFold as any,
  });

  await db
    .update(schema.fixoSessions)
    .set({
      summary: newSummary,
      lastSummarizedMessageId: messagesToFold[messagesToFold.length - 1].id,
    })
    .where(eq(schema.fixoSessions.id, id));

  return c.json({
    summary: newSummary,
    messagesFolded: messagesToFold.length,
  });
});

export { sessions };
```

(Note: this rewrite removes the `vehicleId` join into the list response; client-side grouping is
fine because the sidebar already fetches the vehicles list separately. Confirm that pattern in Phase
3.)

- [ ] **Step 2: Add `import { sql } from "drizzle-orm"`** at the top if not already present.

- [ ] **Step 3: Run typecheck**

```bash
deno task check:gateway
```

Expected: PASS for sessions.ts. Other files (complete.ts, reports.ts) still fail — addressed next.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/routes/fixo/sessions.ts
git commit -m "feat(fixo-gateway): sessions CRUD + /compact + /reports list"
```

### Task 2.4: complete.ts — write to fixo_reports with snapshots

**Files:**

- Modify: `apps/gateway/src/routes/fixo/complete.ts` (full rewrite)

- [ ] **Step 1: Replace the file**

```ts
// apps/gateway/src/routes/fixo/complete.ts
import { Hono } from "hono";
import { convertToModelMessages, type UIMessage } from "ai";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { summarizeFixoSession } from "@hmls/agent";
import { getLogger } from "@logtape/logtape";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { requireReportQuota } from "../../middleware/fixo/tier.ts";
import { prependSessionEvidence } from "./lib/hydrate-media.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "complete"]);

type Variables = { auth: AuthContext };
const complete = new Hono<{ Variables: Variables }>();

complete.post("/:id/complete", async (c) => {
  const auth = c.get("auth");
  const sessionId = parseInt(c.req.param("id"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return c.json({ error: "Invalid session ID" }, 400);
  }

  const tierBlock = await requireReportQuota(auth);
  if (tierBlock) return tierBlock;

  let body: { messages?: UIMessage[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  const startTime = Date.now();

  // Verify ownership and pull vehicle for snapshot
  const [session] = await db
    .select({
      id: schema.fixoSessions.id,
      userId: schema.fixoSessions.userId,
      customerId: schema.fixoSessions.customerId,
      vehicleId: schema.fixoSessions.vehicleId,
    })
    .from(schema.fixoSessions)
    .where(eq(schema.fixoSessions.id, sessionId))
    .limit(1);
  if (
    !session ||
    (session.userId !== auth.userId && session.customerId !== auth.customerId)
  ) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (!session.userId) {
    // legacy customer-only session — D2 says we don't support reports for these
    return c.json({ error: "Reports require an authenticated user" }, 403);
  }

  // Snapshot the vehicle row at this moment (D3 — historical reproducibility)
  let vehicleSnapshot: unknown = null;
  if (session.vehicleId) {
    const [v] = await db
      .select()
      .from(schema.vehicles)
      .where(eq(schema.vehicles.id, session.vehicleId))
      .limit(1);
    if (v) vehicleSnapshot = v;
  }

  // Snapshot media + their signed URLs
  const media = await db
    .select()
    .from(schema.fixoMedia)
    .where(eq(schema.fixoMedia.sessionId, sessionId));
  const mediaSnapshot = media.map((m) => ({
    id: m.id,
    type: m.type,
    storageKey: m.storageKey,
    transcription: m.transcription,
    createdAt: m.createdAt,
  }));

  // Re-attach evidence to messages so the summarizer sees photos and codes
  const attachedMedia = await prependSessionEvidence(
    messages,
    sessionId,
    auth.userId,
    auth.customerId,
  );
  if (attachedMedia > 0) {
    logger.info("Prepended session evidence for completion", { sessionId, attachedMedia });
  }

  const modelMessages = await convertToModelMessages(messages);
  const result = await summarizeFixoSession({ messages: modelMessages });

  const [report] = await db
    .insert(schema.fixoReports)
    .values({
      sessionId,
      userId: session.userId,
      result,
      vehicleSnapshot,
      mediaSnapshot,
      messageCount: messages.length,
    })
    .returning();

  logger.info("Fixo report generated", {
    sessionId,
    reportId: report.id,
    duration: Date.now() - startTime,
    issueCount: result.issues.length,
    overallSeverity: result.overallSeverity,
  });

  return c.json({ reportId: report.id, sessionId, result });
});

export { complete };
```

- [ ] **Step 2: Verify `summarizeFixoSession` is still exported from @hmls/agent**

```bash
grep -rn "summarizeFixoSession" apps/agent/src/ packages/shared/src/
```

If exported, no change. If not, add to `apps/agent/src/mod.ts`. Existing code referenced it so it
should already be exported.

- [ ] **Step 3: Typecheck**

```bash
deno task check:gateway
```

Expected: PASS for complete.ts.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/routes/fixo/complete.ts
git commit -m "feat(fixo-gateway): /complete inserts fixo_reports w/ snapshots"
```

### Task 2.5: reports.ts — read snapshots from fixo_reports

**Files:**

- Modify: `apps/gateway/src/routes/fixo/reports.ts`

The PDF route currently joins fixo_sessions + vehicles + fixo_media to render the report. Switch to
reading the snapshot fields from fixo_reports.

- [ ] **Step 1: Read the existing reports.ts**

```bash
cat apps/gateway/src/routes/fixo/reports.ts
```

Identify where `vehicle`, `media`, and `result` are fetched. Replace those reads with a single
`fixoReports` query keyed by `:id` (UUID) instead of session id.

- [ ] **Step 2: Update the route signature** from `/:id/report` (session-id-keyed) to
      `/:reportId/pdf` (report-id-keyed). The frontend call site in
      `apps/fixo-web/src/lib/download-report.ts` will be updated in Phase 3.

```ts
reports.get("/:reportId/pdf", async (c) => {
  const auth = c.get("auth");
  const reportId = c.req.param("reportId");
  // UUIDv4 validation: ~36 chars w/ dashes
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
    return c.json({ error: "bad report id" }, 400);
  }

  const [report] = await db
    .select()
    .from(schema.fixoReports)
    .where(eq(schema.fixoReports.id, reportId))
    .limit(1);

  if (!report || report.userId !== auth.userId) {
    return c.json({ error: "Report not found" }, 404);
  }

  // Render PDF from snapshot. Existing PDF component lives in
  // apps/agent/src/fixo/pdf/fixo-report.tsx — read it and adapt props
  // to take vehicle_snapshot + media_snapshot instead of live joins.
  // ... (PDF rendering call here, mirroring the existing code's pdf invocation pattern)
});
```

- [ ] **Step 3: Adjust fixo-report.tsx props** if the PDF component still expects live `Vehicle` /
      `FixoMedia` types. Make the component accept the snapshot shape (raw jsonb already has the
      same fields, just from a frozen point in time).

- [ ] **Step 4: Mount the new route in hmls-app.ts**

Find the existing `app.route("/sessions", ...)` block and verify the reports sub-route is mounted at
`/reports/:reportId/pdf`. Adjust the mount path if needed.

- [ ] **Step 5: Typecheck**

```bash
deno task check:gateway
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/fixo/reports.ts apps/agent/src/fixo/pdf/fixo-report.tsx apps/gateway/src/routes/fixo/hmls-app.ts
git commit -m "feat(fixo-gateway): PDF route reads snapshot from fixo_reports"
```

### Task 2.6: Delete session-lifecycle.ts and remove its callers

**Files:**

- Delete: `apps/gateway/src/routes/fixo/lib/session-lifecycle.ts`
- Modify: any file that imported `reopenIfComplete` (already done in Task 2.2 chat.ts)

- [ ] **Step 1: Find remaining references**

```bash
grep -rn "session-lifecycle\|reopenIfComplete" apps/
```

If chat.ts is the only place, delete the file. Otherwise update the remaining call site to be a
no-op or simply remove the call.

- [ ] **Step 2: Delete the file**

```bash
git rm apps/gateway/src/routes/fixo/lib/session-lifecycle.ts
```

- [ ] **Step 3: Typecheck**

```bash
deno task check
```

Expected: PASS for the gateway. Agent should still pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(fixo-gateway): drop session-lifecycle.ts (reopen no longer needed)"
```

### Task 2.7: Update input.ts to use new tier middleware

**Files:**

- Modify: `apps/gateway/src/routes/fixo/input.ts`

`input.ts` currently calls `checkFreeTierLimit(auth, mediaType)` for plus-only enforcement on
photo/audio uploads. Switch to `requireMediaTier(auth)`.

- [ ] **Step 1: Find the call site**

```bash
grep -n "checkFreeTierLimit" apps/gateway/src/routes/fixo/input.ts
```

- [ ] **Step 2: Replace each call**

```ts
import { requireMediaTier } from "../../middleware/fixo/tier.ts";

// Replace:
//   const tierBlock = await checkFreeTierLimit(auth, "photo");
// With:
const tierBlock = requireMediaTier(auth);
```

- [ ] **Step 3: Typecheck + commit**

```bash
deno task check:gateway
git add apps/gateway/src/routes/fixo/input.ts
git commit -m "refactor(fixo-gateway): input.ts uses requireMediaTier"
```

### Task 2.8: Mount the new compact route + verify route table

**Files:**

- Modify: `apps/gateway/src/routes/fixo/hmls-app.ts` (or wherever fixo routes get mounted)

The /compact route was added inline in sessions.ts. Confirm it's reachable.

- [ ] **Step 1: Find the fixo mount point**

```bash
grep -rn "fixo/sessions\|sessions.ts\|chat.ts" apps/gateway/src/ | grep route
```

- [ ] **Step 2: Manually test the route table** by running the dev server and hitting each new
      endpoint with curl. (Plan-phase placeholder; this is a smoke test only.)

```bash
infisical run --env=dev -- deno task dev:api
# in another terminal:
curl -X POST http://fixo.localhost:8080/sessions -H "Authorization: Bearer $(cat ~/.fixo-test-token)"
```

- [ ] **Step 3: Commit any wire-up fixes if needed.**

---

## Phase 3 — Frontend

The frontend is the largest visible change. We replace the chat layout, add a sidebar with vehicle
grouping, delete /history, and rewire the first-send flow.

### Task 3.1: Eager session creation in useAgentChat

**Files:**

- Modify: `apps/fixo-web/src/hooks/useAgentChat.ts` (around line 328 sendMessage)
- Modify: `apps/fixo-web/src/lib/session.ts` (drop lazy-create)

- [ ] **Step 1: Add a helper to lib/session.ts** for eager session creation:

```ts
// Replace the existing ensureSession with createSessionEager.
// ensureSession's lazy semantics are removed; the only caller (Report flow)
// will now POST /sessions directly when needed.

export async function createSessionEager(accessToken: string): Promise<number> {
  const res = await fetch(`${AGENT_URL}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = (await res.json()) as { sessionId: number };
  return data.sessionId;
}
```

- [ ] **Step 2: Modify `useAgentChat.sendMessage`** to eager-create on first send:

```ts
const sendMessage = useCallback(
  async (content: string, options?: { imageUrl?: string }) => {
    if (options?.imageUrl) {
      pendingImageUrlRef.current = {
        index: chatMessages.length,
        url: options.imageUrl,
      };
    }

    // Eager create on first send. After creation, replace URL via native
    // history API (NOT router.push) so the React tree stays mounted and the
    // in-flight stream survives.
    if (sessionIdRef && !sessionIdRef.current && accessToken) {
      try {
        const newId = await createSessionEager(accessToken);
        sessionIdRef.current = newId;
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/chat/${newId}`);
        }
      } catch (err) {
        console.error("[agent] session create failed", err);
        // continue without session; the gateway will reject because sessionId
        // is now required
      }
    }

    chatSendMessage({ text: content });
  },
  [chatSendMessage, chatMessages, accessToken, sessionIdRef],
);
```

- [ ] **Step 3: Run typecheck**

```bash
cd apps/fixo-web && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/fixo-web/src/hooks/useAgentChat.ts apps/fixo-web/src/lib/session.ts
git commit -m "feat(fixo-web): eager session create + history.replaceState first-send"
```

### Task 3.2: New /chat/[id] client page

**Files:**

- Create: `apps/fixo-web/src/app/(app)/chat/[id]/page.tsx`
- Modify: `apps/fixo-web/src/app/(app)/chat/page.tsx` (simplify to blank-state landing)

- [ ] **Step 1: Create the [id] route**

```tsx
// apps/fixo-web/src/app/(app)/chat/[id]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { redirect, useParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";
import type { UIMessage } from "ai";
import { ChatPageInner } from "@/components/chat/ChatPageInner";

interface SessionResponse {
  session: {
    id: number;
    messages: UIMessage[] | null;
    vehicleId: string | null;
    title: string | null;
    archivedAt: string | null;
  };
}

export default function ChatByIdPage() {
  const { session, user, isLoading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(params.id);

  const [data, setData] = useState<SessionResponse["session"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (authLoading) return <Spinner />;
  if (!session || !user) redirect("/login");
  if (!Number.isInteger(sessionId)) redirect("/chat");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${AGENT_URL}/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;
        if (res.status === 404) {
          redirect("/chat");
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const json = (await res.json()) as SessionResponse;
        setData(json.session);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, session.access_token]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <Spinner />;

  return (
    <ChatPageInner
      key={data.id}
      session={session}
      userId={user.id}
      sessionId={data.id}
      initialMessages={data.messages ?? []}
      archived={!!data.archivedAt}
    />
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-dvh">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-dvh gap-2 text-center p-6">
      <p className="text-red-600 font-medium">Could not load chat</p>
      <p className="text-sm text-muted-foreground max-w-md">{message}</p>
    </div>
  );
}
```

- [ ] **Step 2: Extract `ChatPageInner` to a shared component**

The current `apps/fixo-web/src/app/(app)/chat/page.tsx` defines `ChatPageInner` inline. Move it to
`apps/fixo-web/src/components/chat/ChatPageInner.tsx` so both routes can import it. Update its props
to accept `initialMessages` and `sessionId` from props (no more bootstrap fetch logic — that lives
in the [id] page now).

- [ ] **Step 3: Simplify /chat (no id) to blank state**

```tsx
// apps/fixo-web/src/app/(app)/chat/page.tsx
"use client";

import { redirect } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { ChatPageInner } from "@/components/chat/ChatPageInner";

export default function NewChatPage() {
  const { session, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!session || !user) redirect("/login");

  return (
    <ChatPageInner
      session={session}
      userId={user.id}
      sessionId={null}
      initialMessages={[]}
      archived={false}
    />
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-dvh">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}
```

- [ ] **Step 4: Update `ChatPageInner` to take `sessionId: number | null`** and forward to
      `useAgentChat` with `sessionIdRef.current = sessionId`. The hook's existing eager-create logic
      kicks in on first send when sessionId is null.

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/fixo-web && bun run typecheck && bun run lint
```

```bash
git add apps/fixo-web/src/app/(app)/chat/page.tsx apps/fixo-web/src/app/(app)/chat/\[id\]/page.tsx apps/fixo-web/src/components/chat/ChatPageInner.tsx
git commit -m "feat(fixo-web): /chat blank-state + /chat/[id] resumed conversation"
```

### Task 3.3: Sidebar with vehicle grouping

**Files:**

- Create: `apps/fixo-web/src/components/chat/ChatList.tsx`
- Create: `apps/fixo-web/src/components/chat/ChatListItem.tsx`
- Create: `apps/fixo-web/src/components/chat/VehicleGroupHeader.tsx`
- Create: `apps/fixo-web/src/components/chat/NewChatButton.tsx`
- Modify: `apps/fixo-web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add SWR if not already installed**

```bash
cd apps/fixo-web && bun add swr
```

- [ ] **Step 2: Create ChatList**

```tsx
// apps/fixo-web/src/components/chat/ChatList.tsx
"use client";

import useSWR from "swr";
import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";
import { VehicleGroupHeader } from "./VehicleGroupHeader";
import { ChatListItem } from "./ChatListItem";

interface SessionListItem {
  id: number;
  title: string | null;
  vehicleId: string | null;
  lastMessageAt: string;
  createdAt: string;
  archivedAt: string | null;
}

interface VehicleSummary {
  id: string;
  year: number;
  make: string;
  model: string;
}

const fetcher = async ([url, token]: [string, string]) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

export function ChatList() {
  const { session } = useAuth();
  const [showArchived, setShowArchived] = useState(false);

  const sessionsKey = session?.access_token
    ? [`${AGENT_URL}/sessions${showArchived ? "?include_archived=true" : ""}`, session.access_token]
    : null;

  const { data: sessionData, mutate } = useSWR<{ sessions: SessionListItem[] }>(
    sessionsKey,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: vehicleData } = useSWR<{ vehicles: VehicleSummary[] }>(
    session?.access_token ? [`${AGENT_URL}/vehicles`, session.access_token] : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const sessions = sessionData?.sessions ?? [];
  const vehicles = vehicleData?.vehicles ?? [];

  const grouped = groupByVehicle(sessions, vehicles);

  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      {grouped.map((group) => (
        <VehicleGroupHeader key={group.key} label={group.label}>
          {group.sessions.map((s) => (
            <ChatListItem
              key={s.id}
              session={s}
              onMutate={mutate}
            />
          ))}
        </VehicleGroupHeader>
      ))}
      <label className="flex items-center gap-2 mt-2 px-2 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived
      </label>
    </div>
  );
}

function groupByVehicle(
  sessions: SessionListItem[],
  vehicles: VehicleSummary[],
): { key: string; label: string; sessions: SessionListItem[] }[] {
  const map = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const key = s.vehicleId ?? "__unassigned__";
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  // Sort within group by lastMessageAt DESC
  for (const list of map.values()) {
    list.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }
  // Sort groups: most recently active first; "Unassigned" always last
  const entries = Array.from(map.entries()).map(([key, list]) => {
    if (key === "__unassigned__") {
      return { key, label: "Unassigned", sessions: list, latest: "" };
    }
    const v = vehicles.find((vv) => vv.id === key);
    const label = v ? `${v.year} ${v.make} ${v.model}` : "Unknown vehicle";
    return { key, label, sessions: list, latest: list[0]?.lastMessageAt ?? "" };
  });
  entries.sort((a, b) => {
    if (a.key === "__unassigned__") return 1;
    if (b.key === "__unassigned__") return -1;
    return b.latest.localeCompare(a.latest);
  });
  return entries.map(({ key, label, sessions }) => ({ key, label, sessions }));
}
```

- [ ] **Step 3: Create ChatListItem**

```tsx
// apps/fixo-web/src/components/chat/ChatListItem.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { RenameDialog } from "./RenameDialog";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { AGENT_URL } from "@/lib/config";
import { useAuth } from "@/components/AuthProvider";

interface Props {
  session: {
    id: number;
    title: string | null;
    archivedAt: string | null;
    lastMessageAt: string;
  };
  onMutate: () => void;
}

export function ChatListItem({ session, onMutate }: Props) {
  const path = usePathname();
  const isActive = path === `/chat/${session.id}`;
  const { session: authSession } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const archive = async () => {
    if (!authSession) return;
    await fetch(`${AGENT_URL}/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${authSession.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        archivedAt: session.archivedAt ? null : new Date().toISOString(),
      }),
    });
    onMutate();
  };

  const titleText = session.title ?? "Untitled";
  return (
    <div
      className={`flex items-center justify-between gap-1 rounded px-2 py-1.5 text-sm hover:bg-muted ${
        isActive ? "bg-muted" : ""
      } ${session.archivedAt ? "opacity-60" : ""}`}
    >
      <Link href={`/chat/${session.id}`} className="flex-1 truncate">
        {titleText}
      </Link>
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label={`Actions for ${titleText}`}
        className="opacity-0 group-hover:opacity-100 hover:bg-background rounded p-1"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {menuOpen && (
        <div className="absolute right-2 top-full z-20 mt-1 rounded border border-border bg-popover shadow-md">
          <button
            onClick={() => {
              setMenuOpen(false);
              setRenameOpen(true);
            }}
          >
            Rename
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              archive();
            }}
          >
            {session.archivedAt ? "Unarchive" : "Archive"}
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            Delete
          </button>
        </div>
      )}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={session.id}
        currentTitle={titleText}
        onMutate={onMutate}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        sessionId={session.id}
        onMutate={onMutate}
      />
    </div>
  );
}
```

- [ ] **Step 4: Create VehicleGroupHeader**

```tsx
// apps/fixo-web/src/components/chat/VehicleGroupHeader.tsx
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function VehicleGroupHeader(props: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="group">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="truncate">{props.label}</span>
      </button>
      {open && <div className="flex flex-col">{props.children}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Create NewChatButton, RenameDialog, DeleteConfirmDialog**

These are mechanical shadcn-flavored components. Write them following the patterns already used in
fixo-web (look at `components/ui/dialog.tsx` if it exists for the import path). Keep dialogs
minimal:

- `NewChatButton.tsx`: a button that calls `router.push('/chat')`.
- `RenameDialog.tsx`: shadcn `Dialog` + input + Save button that PATCHes title.
- `DeleteConfirmDialog.tsx`: shadcn `AlertDialog` with destructive button + warning copy "Reports
  and uploaded photos will be permanently deleted." Calls DELETE.

(Code omitted — straight CRUD wrapped in shadcn primitives. If shadcn's AlertDialog is not yet
installed, run `bunx shadcn@latest add alert-dialog`.)

- [ ] **Step 6: Wire ChatList into Sidebar**

```tsx
// apps/fixo-web/src/components/Sidebar.tsx
// (top of existing file)
import { ChatList } from "./chat/ChatList";
import { NewChatButton } from "./chat/NewChatButton";

// inside the existing Sidebar render, replace whatever placeholder list lives
// there with:
<aside className="hidden lg:flex h-dvh w-64 flex-col border-r border-border bg-background">
  <div className="flex h-14 items-center justify-between px-3 border-b border-border">
    <span className="text-sm font-semibold">
      Fixo<span className="text-accent">.</span>
    </span>
    <NewChatButton />
  </div>
  <div className="flex-1 overflow-y-auto">
    <ChatList />
  </div>
</aside>;
```

- [ ] **Step 7: Add a backend `GET /vehicles` route** if it doesn't exist yet. The ChatList relies
      on it.

```bash
grep -rn "GET .*\/vehicles\|/vehicles" apps/gateway/src/routes/fixo/
```

If missing, add a minimal endpoint to `apps/gateway/src/routes/fixo/vehicles.ts` returning
`{ vehicles: VehicleSummary[] }` for the authenticated user. Mount in `hmls-app.ts`.

- [ ] **Step 8: Typecheck + lint + commit**

```bash
cd apps/fixo-web && bun run typecheck && bun run lint
```

```bash
git add apps/fixo-web/src/components/chat/ apps/fixo-web/src/components/Sidebar.tsx apps/fixo-web/package.json apps/fixo-web/bun.lock
git commit -m "feat(fixo-web): sidebar ChatList grouped by vehicle"
```

### Task 3.4: Mobile Chats sheet on BottomNav

**Files:**

- Modify: `apps/fixo-web/src/components/BottomNav.tsx`

- [ ] **Step 1: Add a "Chats" tab** that opens a shadcn `Sheet` containing `<ChatList />`. Pattern
      follows existing BottomNav tabs (look at how /history was navigated to before — replace it).

- [ ] **Step 2: Run mobile dev locally + verify**

```bash
cd apps/fixo-web && bun run dev
# Open http://localhost:3000 in mobile-emulation. Tap Chats. Sheet opens.
```

- [ ] **Step 3: Commit**

```bash
git add apps/fixo-web/src/components/BottomNav.tsx
git commit -m "feat(fixo-web): mobile Chats tab via shadcn Sheet"
```

### Task 3.5: Compact button in chat header

**Files:**

- Modify: `apps/fixo-web/src/components/chat/ChatPageInner.tsx` (header section)

- [ ] **Step 1: Add the button**

```tsx
const [isCompacting, setIsCompacting] = useState(false);
const [compactToast, setCompactToast] = useState<string | null>(null);

const handleCompact = async () => {
  if (!session.access_token || sessionIdRef.current === null) return;
  setIsCompacting(true);
  try {
    const res = await fetch(`${AGENT_URL}/sessions/${sessionIdRef.current}/compact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    setCompactToast(`Compacted ${data.messagesFolded ?? 0} messages.`);
    setTimeout(() => setCompactToast(null), 4000);
  } catch (e) {
    setCompactToast("Compact failed.");
  } finally {
    setIsCompacting(false);
  }
};

// In the header, next to the Report button:
<button onClick={handleCompact} disabled={isCompacting}>
  {isCompacting ? "Compacting…" : "Clean up context"}
</button>;
{
  compactToast && <Toast>{compactToast}</Toast>;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/fixo-web/src/components/chat/ChatPageInner.tsx
git commit -m "feat(fixo-web): manual compact button in chat header"
```

### Task 3.6: Update download-report.ts for new report-id-keyed PDF route

**Files:**

- Modify: `apps/fixo-web/src/lib/download-report.ts`

- [ ] **Step 1: Find the existing function**

```bash
cat apps/fixo-web/src/lib/download-report.ts
```

- [ ] **Step 2: Update signature** from `downloadReportPdf(sessionId, token)` to
      `downloadReportPdf(reportId: string, token: string)`. The call sites change too — Report flow
      now needs to:
  1. POST /sessions/:id/complete → get reportId back
  2. Call downloadReportPdf(reportId)

- [ ] **Step 3: Update call sites in ChatPageInner.tsx Report click handler**:

```tsx
const completeRes = await fetch(`${AGENT_URL}/sessions/${sid}/complete`, {
  method: "POST",
  headers: { ... },
  body: JSON.stringify({ messages: uiMessages }),
});
const { reportId } = await completeRes.json();
await downloadReportPdf(reportId, session.access_token);
```

- [ ] **Step 4: Commit**

```bash
git add apps/fixo-web/src/lib/download-report.ts apps/fixo-web/src/components/chat/ChatPageInner.tsx
git commit -m "feat(fixo-web): downloadReportPdf takes reportId not sessionId"
```

### Task 3.7: Delete /history page

**Files:**

- Delete: `apps/fixo-web/src/app/(app)/history/page.tsx`
- Modify: any nav link that points to /history

- [ ] **Step 1: Find lingering references**

```bash
grep -rn "history" apps/fixo-web/src/components/
grep -rn "/history" apps/fixo-web/src/
```

- [ ] **Step 2: Remove all `/history` links from BottomNav and any other nav components.**

- [ ] **Step 3: Delete the file**

```bash
rm -r apps/fixo-web/src/app/\(app\)/history/
```

- [ ] **Step 4: Typecheck + lint + commit**

```bash
cd apps/fixo-web && bun run typecheck && bun run lint
git add -A
git commit -m "chore(fixo-web): drop /history page (replaced by sidebar)"
```

---

## Phase 4 — Verification

### Task 4.1: End-to-end smoke test

- [ ] **Step 1: Start the stack**

```bash
infisical run --env=dev -- deno task dev:api
# Separate terminal:
cd apps/fixo-web && GATEWAY_URL=http://localhost:8080 infisical run --env=dev -- bun run dev
```

- [ ] **Step 2: In the browser at localhost:3000:**

Walk through the QA checklist from spec §9.4:

- [ ] New chat from blank state → URL upgrades to `/chat/[id]` after first send
- [ ] In-flight message survives URL change
- [ ] Title auto-generates within ~3s
- [ ] Sidebar groups sessions by vehicle (after at least one assistant turn establishes vehicle)
- [ ] "Show archived" toggle reveals greyed-out archived sessions
- [ ] Rename dialog persists title; auto-titler does not overwrite
- [ ] Archive then unarchive works
- [ ] Delete: confirmation copy mentions reports + photos; row disappears; reports + media +
      obd_codes rows are gone in DB
- [ ] Free-tier user: 5 messages permitted, 6th rejected; 1 report permitted, 2nd rejected
- [ ] Same user_message_id POSTed twice does not double-count
- [ ] Send 25 long messages on one session → "Compacted N messages" toast eventually appears OR
      manual compact button works
- [ ] Mobile (DevTools Mobile emulation): "Chats" BottomNav tab opens Sheet with ChatList

### Task 4.2: Run full test suite + CI gates

- [ ] **Step 1: Deno tests**

```bash
deno task test
```

- [ ] **Step 2: Web lint + typecheck + build**

```bash
cd apps/fixo-web && bun run lint && bun run typecheck && bun run build
```

- [ ] **Step 3: Deno check + fmt + lint**

```bash
deno task check && deno task fmt:check && deno task lint
```

- [ ] **Step 4: If any fail, fix and re-run.** Do NOT skip.

### Task 4.3: Final commit + ready for PR

- [ ] **Step 1: Squash WIP commits if needed** (optional)

- [ ] **Step 2: Push branch**

```bash
git push -u origin spinsirr/happy-kapitsa-6f3fab
```

- [ ] **Step 3: Open PR** with title and description summarizing the conversion + testing notes.

---

## Self-Review

I checked the plan against the spec and the brainstorming session output:

- ✅ D1 (preserve media in summaries) → Task 1.2 SUMMARIZER_SYSTEM
- ✅ D2 (drop legacy customer-only) → Task 0.2 step 1 INSERT WHERE clause; Task 2.4 explicit 403 for
  customer-only
- ✅ D3 (report snapshot vehicle + media) → Task 0.2 step 1 schema; Task 2.4 fills snapshot fields
- ✅ T1 (vehicle grouping) → Task 3.3 ChatList groupByVehicle
- ✅ Codex #1 (media after compact) → Task 1.2 prompt point 7
- ✅ Codex #2 + #3 (concurrency + cursor) → Task 1.3 FOR UPDATE + last_summarized_message_id
- ✅ Codex #4 (idempotent counter) → Task 0.1 step 4 (table) + Task 2.2 chat.ts (insert + rollback
  on quota miss)
- ✅ Codex #5 (first-send race) → Task 3.1 history.replaceState
- ✅ Codex #6 (delete /history) → Task 3.7
- ✅ Codex #7 (snapshot completeness) → Task 2.4 vehicle + media snapshot
- ✅ Codex #8 (sort order) → Task 0.1 last_message_at index + Task 2.3 orderBy
- ✅ Codex #9 (tier middleware factoring) → Task 2.1
- ✅ Codex #10 (migration data shape) → Task 0.2 jsonb_array_elements WHERE type='text'
- ✅ Codex #11 (token estimator) → Task 1.1 (fallback shipped now; real tokenizer is V2 /
  open-questions follow-up)
- ✅ Codex #12 (auto-archive removed) → Task 0.2 has no auto-archive step
- ✅ My #4 (r2_key column name) → Task 2.3 uses Drizzle field name `storageKey` which maps to
  `r2_key`
- ✅ My #5 (counter FK) → Task 0.1 step 4 has `references(...)` with cascade
- ✅ My #6 (title race) → Task 2.2 maybeGenerateTitle WHERE adds `isNull(title)`
- ✅ My #7 (counter race window) → Task 2.2 idempotency model eliminates window

**Placeholder scan:**

- Task 2.5 step 2/3 reference "Existing PDF component lives in
  apps/agent/src/fixo/pdf/fixo-report.tsx — read it and adapt props". This is acceptable: the
  engineer reads the file and follows the existing render pattern; the type changes are minimal
  (FixoMedia → media-snapshot row shape with same fields).
- Task 3.3 step 5 "Code omitted — straight CRUD wrapped in shadcn primitives". This is a known minor
  placeholder. The dialogs are 30-line standard shadcn patterns; the engineer can lean on existing
  Dialog usages elsewhere in the codebase. NOT a blocker.
- Task 3.4 says "look at how /history was navigated to before — replace it" — clear enough.
- Task 4.1 has `[ ]` checkboxes to indicate manual QA items, not implementation steps. Intentional.

**Type consistency:** `lastSummarizedMessageId` (Drizzle field) ↔ `last_summarized_message_id` (SQL)
is consistent; `userMessageId` ↔ `user_message_id` consistent. `findCursorIndex` and
`buildAgentContext` references match. `requireTextQuota` / `requireMediaTier` / `requireReportQuota`
used consistently across Phase 2 tasks.

No issues found.

---

## Execution Handoff

Plan complete and saved to
[docs/superpowers/plans/2026-05-04-fixo-session-context-management.md](docs/superpowers/plans/2026-05-04-fixo-session-context-management.md).
Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks,
fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with
checkpoints.

Which approach?
