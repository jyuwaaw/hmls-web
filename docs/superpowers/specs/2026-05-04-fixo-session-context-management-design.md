# Fixo Session & Context Management — Design

**Date:** 2026-05-04 **Status:** Approved (brainstorming complete, ready for plan) **Owner:**
Spinsirr

## 1. Problem

Fixo's chat experience has two related gaps:

1. **No session-management UX.** Sessions exist as DB rows
   ([`fixo_sessions`](packages/shared/src/db/schema.ts:294)), and a separate `/history` page lists
   them, but the chat page itself has no "new chat", session list, rename, or delete affordances.
   Users can only switch sessions by navigating to `/history` and clicking back. Lazy session
   creation also breaks cross-device continuity for text-only chats — they live only in localStorage
   until the user generates a report.
2. **No agent-side context management.** [`runFixoAgent`](apps/agent/src/fixo/agent.ts:49) passes
   the full message history straight to `streamText` every turn. There is no token budget, no
   sliding window, no summarization. Long conversations blow up input-token cost linearly and will
   eventually approach Gemini's context window.

Compounding these: the current data model conflates "session" with "diagnostic case." Status enum
(`pending → complete → failed`), `result` column, `completedAt`, and the
[`reopenIfComplete`](apps/gateway/src/routes/fixo/lib/session-lifecycle.ts:21) patch logic all
assume sessions are short-lived task units — a model that fights ChatGPT-style continuous chat UX.

## 2. Goals

- **Session = conversation.** Sessions are open-ended, never "complete." Reports become a separate
  entity.
- **Vehicle as the primary grouping.** Sidebar groups sessions by `fixo_sessions.vehicle_id`. No new
  "project" entity — the existing `vehicles` table is the project.
- **Visible session management.** Users can create, switch, rename, archive, and delete chats from a
  sidebar inside `/chat` itself.
- **Bounded agent context cost.** Long conversations stay at roughly constant input-token cost via
  incremental summarization.
- **Calmer schema.** Drop the patch logic (`reopenIfComplete`, status enum, status-based tier
  counting) that the task model required.

Non-goals (V2 candidates):

- Cross-session search, tags, folders, pinning
- Cross-session "project memory" — facts known about a vehicle persisting into every new chat about
  that vehicle
- Shared / collaborative sessions
- Vector retrieval ("find a past session with similar symptoms")
- Structured fact extraction (vs free-text summary)
- Report PDFs with charts / images embedded
- `/history` standalone page — replaced by sidebar with archive-toggle

## 3. Architecture overview

### 3.1 Mental-model shift

| Aspect            | Current (task model)                               | Target (conversation model)                                                              |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Session unit      | One diagnostic case                                | One ongoing chat                                                                         |
| Lifecycle         | `pending → complete → failed`                      | Open forever; archive or delete                                                          |
| Result            | Single `result` jsonb on session                   | Multiple snapshot rows in `fixo_reports`, including snapshotted vehicle + media metadata |
| Completion        | Explicit `/complete` flips status                  | `/complete` inserts a report row, session unaffected                                     |
| Reopen            | `reopenIfComplete` after follow-up                 | Not needed                                                                               |
| Sort order        | `created_at`                                       | `last_message_at` (new column)                                                           |
| Free-tier counter | `count(sessions WHERE status != failed)` per month | `fixo_message_events` (idempotent per-message) + `count(fixo_reports)` per month         |
| Grouping          | Flat list                                          | Grouped by `vehicle_id` (existing column)                                                |
| History view      | `/history` page                                    | Sidebar `Show archived` toggle                                                           |

### 3.2 Component boundaries

```
fixo-web
├── /chat            (no id) → blank-state landing
├── /chat/[id]       resumed conversation
└── Sidebar          ChatList grouped by vehicle (new)

(/history page deleted — see §5.6)

gateway
├── POST  /sessions             create (eager on first send)
├── GET   /sessions             list. Default excludes archived.
│                               `?include_archived=true` for archive toggle.
│                               Returns sessions sorted by last_message_at DESC,
│                               grouped client-side by vehicle_id.
├── GET   /sessions/:id         detail (incl. messages)
├── PATCH /sessions/:id         rename, archive, unarchive
├── DELETE /sessions/:id        hard delete (cascades to reports + media)
├── POST  /sessions/:id/compact manual context compaction
├── POST  /sessions/:id/complete generate a report row (was: flip status)
├── GET   /sessions/:id/reports list reports for this session
├── GET   /reports/:id/pdf      download report PDF (was: /sessions/:id/report)
└── POST  /task                 chat (unchanged URL, internal context-build added)

agent
├── buildAgentContext()         new — assembles systemPrompt + modelMessages
├── runFixoAgent()              accepts pre-built systemPrompt parameter
└── summarizer.ts               new — Gemini 2.5 Flash, fold-into-summary prompt
```

## 4. Data model

### 4.1 `fixo_sessions` (mutated)

```sql
ALTER TABLE fixo_sessions
  DROP COLUMN result,
  DROP COLUMN status,
  DROP COLUMN completed_at,
  ADD COLUMN title text,
  ADD COLUMN title_is_user_set boolean NOT NULL DEFAULT false,
  ADD COLUMN summary text,
  ADD COLUMN last_summarized_message_id text,
  ADD COLUMN last_message_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN archived_at timestamptz;

CREATE INDEX idx_fixo_sessions_user_last_msg
  ON fixo_sessions (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

DROP TYPE fixo_session_status;
```

| Column                                       | Type        | Notes                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `user_id`, `customer_id`, `vehicle_id` | (existing)  | unchanged. Sidebar groups by `vehicle_id`.                                                                                                                                                                                                                                                                                                                |
| `messages`                                   | jsonb       | unchanged — full transcript of `UIMessage[]`.                                                                                                                                                                                                                                                                                                             |
| `credits_charged`                            | integer     | unchanged — legacy Stripe credits.                                                                                                                                                                                                                                                                                                                        |
| `created_at`                                 | timestamptz | unchanged.                                                                                                                                                                                                                                                                                                                                                |
| `title`                                      | text        | nullable until first auto-gen completes; UI fallback uses message preview.                                                                                                                                                                                                                                                                                |
| `title_is_user_set`                          | boolean     | once true, auto-titler skips this row.                                                                                                                                                                                                                                                                                                                    |
| `summary`                                    | text        | rolled-up "known facts" memo (max ~800 tokens).                                                                                                                                                                                                                                                                                                           |
| `last_summarized_message_id`                 | text        | **stable** message id (from UIMessage.id) of the last message folded into `summary`. Used instead of an array index because the messages array is mutated by hydration paths ([hydrate-media.ts:183](apps/gateway/src/routes/fixo/lib/hydrate-media.ts:183), [chat.ts:65](apps/gateway/src/routes/fixo/chat.ts:65)) — index-based cursors silently drift. |
| `last_message_at`                            | timestamptz | bumped on every successful POST /task. Used for sidebar sort order so revived old conversations float to the top.                                                                                                                                                                                                                                         |
| `archived_at`                                | timestamptz | soft-delete; default `GET /sessions` excludes; sidebar "Show archived" toggle includes.                                                                                                                                                                                                                                                                   |

### 4.2 `fixo_reports` (new)

Reports are **full snapshots**, not pointers — vehicle metadata and media URLs are copied at
generation time. This satisfies D3 (Decision 3, 2026-05-04 brainstorming): later vehicle edits or
media deletions must not change historical report rendering.

```sql
CREATE TABLE fixo_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  result           jsonb NOT NULL,           -- issues + overallSeverity (the LLM-generated diagnosis)
  vehicle_snapshot jsonb,                    -- frozen copy of vehicles row at generation time
  media_snapshot   jsonb NOT NULL,           -- [{ id, type, signedUrl, transcription, createdAt }]
  message_count    integer NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_reports_session ON fixo_reports(session_id, generated_at DESC);
CREATE INDEX idx_fixo_reports_user    ON fixo_reports(user_id, generated_at DESC);
```

`message_count` = number of `messages` array entries at the moment the report was generated.

`uuid` (not serial) for parity with [`fixo_estimates`](packages/shared/src/db/schema.ts:355) and to
avoid leaking growth rate when report ids appear in URLs.

### 4.3 `fixo_message_events` (new — replaces the prior counter table)

Idempotent per-message ledger. The PRIMARY KEY on the user-message id makes the count exact-once
even under client retries / network jitter.

```sql
CREATE TABLE fixo_message_events (
  user_message_id text  PRIMARY KEY,         -- UIMessage.id from the AI SDK
  user_id         uuid  NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  month           date  NOT NULL,            -- first day of month, UTC
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_msg_events_user_month ON fixo_message_events(user_id, month);
```

**Write path (in POST /task entry, before running the agent):**

```sql
INSERT INTO fixo_message_events (user_message_id, user_id, session_id, month)
VALUES ($1, $2, $3, date_trunc('month', NOW() AT TIME ZONE 'UTC')::date)
ON CONFLICT (user_message_id) DO NOTHING
RETURNING user_message_id;
```

If `RETURNING` produces a row → first time we see this message → counts toward quota. If empty →
it's a retry/replay, **do not** double-count.

**Read path (quota check):**

```sql
SELECT count(*) FROM fixo_message_events
WHERE user_id = $1 AND month = $2;
```

Indexed scan, O(messages-this-month) — bounded.

This replaces the originally-proposed `fixo_message_counters` table because the fire-and-forget
UPDATE pattern was both lossy (process death between stream finish and counter write) and
double-countable (client retry). The events table fixes both.

## 5. Frontend UX

### 5.1 Routing

```
/chat           — blank-state landing page (no session yet)
/chat/[id]      — named session page
```

`/history` route is **deleted**. Archive functionality moves to a "Show archived" toggle in the
sidebar (§5.6).

`/chat` (no id) renders only the welcome screen + input. **First-send flow** (codex review #5 —
handles in-flight remount race):

1. User types a message and hits send.
2. Hook awaits `POST /sessions` → returns `{ sessionId }`.
3. Hook stores sessionId in a ref + calls `window.history.replaceState(null, '', '/chat/' + id)`
   (NOT `router.push` / `router.replace`). Native history mutation does not unmount the React tree,
   so the in-flight stream survives.
4. Stream proceeds against the new sessionId.
5. On next navigation event (sidebar click, hard refresh), the URL is correct and `/chat/[id]`
   resolves normally.

`router.push('/chat/' + id)` is reserved for _navigation_ away from a finished session (sidebar
clicks, history back-button), not for the initial URL-upgrade after creation. This keeps the hook's
`key={id}` strategy safe — keying only flips when the user explicitly switches conversations.

### 5.2 Sidebar (`apps/fixo-web/src/components/Sidebar.tsx`)

```
Sidebar (lg+ permanent, mobile via Sheet from BottomNav)
├── Header
│   ├── Logo
│   └── [+ New chat] button → router.push('/chat')
├── ChatList (grouped by vehicle_id, sorted by last_message_at DESC within group)
│   ├── ▾ 2020 Honda Civic (vehicle 1)
│   │   ├── ChatListItem · "Brake noise"
│   │   └── ChatListItem · "Oil change question"
│   ├── ▾ 2018 Tesla Model 3
│   │   └── ChatListItem · "Battery warning"
│   └── ▾ Unassigned (sessions with vehicle_id = null)
│       └── ChatListItem · "Untitled diagnosis"
├── [▢ Show archived] toggle (renders archived sessions inline within their vehicle group)
└── BottomNav (mobile only — already exists)
```

ChatListItem ⋯ menu: Rename / Archive / Delete. Vehicle group headers are collapsible (state
per-group in localStorage).

New components, all under `apps/fixo-web/src/components/chat/`:

- `ChatList.tsx` — fetches `GET /sessions` via SWR, groups by `vehicle_id`, renders 20 most-recent
  per vehicle
- `ChatListItem.tsx` — single row + ⋯ menu
- `VehicleGroupHeader.tsx` — collapsible group header showing vehicle year/make/model
- `NewChatButton.tsx` — sidebar header CTA
- `RenameDialog.tsx` — shadcn Dialog wrapping `PATCH /sessions/:id`
- `DeleteConfirmDialog.tsx` — destructive confirmation; states "Reports and uploaded photos will be
  permanently deleted"

Mobile: BottomNav gets a new "Chats" tab that opens the ChatList in a full-screen `Sheet`.

**No SSR / server component for `/chat/[id]`.** The session fetch happens client-side with a
skeleton state during load, mirroring existing patterns. Server components would need
`@supabase/ssr` cookie reading + Bearer-header forwarding, and the latency win does not justify the
auth-flow complexity for a private route.

### 5.3 Title generation

Trigger: first assistant turn `onFinish` in [`chat.ts`](apps/gateway/src/routes/fixo/chat.ts:110).

```ts
if (parsedSessionId !== null) {
  // fire-and-forget. The WHERE clause is the race guard:
  //   - title IS NULL prevents the second concurrent /task from re-generating
  //   - title_is_user_set = false prevents auto-overwrite of a renamed title
  generateText({
    model: google("gemini-2.5-flash"),
    prompt:
      `Summarize this car-diagnosis conversation as a 4-6 word title. No quotes, no period.\n\nConversation:\n${preview}`,
  })
    .then((result) =>
      db.update(fixoSessions)
        .set({ title: result.text.trim() })
        .where(and(
          eq(id, parsedSessionId),
          sql`title IS NULL`,
          eq(title_is_user_set, false),
        ))
    )
    .catch((err) => logger.warn("title generation failed", { sessionId, err }));
}
```

Fallback when `title` is null: UI displays first 40 chars of first user message + "…".

User rename: `PATCH /sessions/:id { title }` sets `title_is_user_set = true`. The auto-title path
checks both the `IS NULL` and the `title_is_user_set = false` predicates and writes nothing if
either fails.

### 5.4 Data flow on switch

1. User clicks ChatListItem → `router.push('/chat/' + id)`
2. `/chat/[id]/page.tsx` (client component with skeleton) fetches `GET /sessions/:id` and seeds
   `useAgentChat`
3. Hook mounts with `key={id}` so it fully resets between sessions
4. localStorage path is preserved as offline fallback (existing behavior)

### 5.5 Vehicle grouping

Sidebar groups by `fixo_sessions.vehicle_id`. Sessions without a vehicle (legacy or in-flight before
vehicle is captured) live in the **"Unassigned"** group.

Once an agent turn captures or confirms a vehicle, the agent's `assign_vehicle` tool (already exists
or trivially added) writes `fixo_sessions.vehicle_id`. The sidebar SWR cache invalidates on the same
/sessions key, so the session moves into its vehicle group on next refresh.

Vehicle group order: **most recent activity wins** — the group whose newest session has the latest
`last_message_at` floats to the top.

### 5.6 Archive vs delete

- **Archive** (`PATCH archived_at`) — soft-delete; row stays, reports stay, removed from default
  `GET /sessions`. Sidebar "Show archived" toggle calls `GET /sessions?include_archived=true` and
  renders archived sessions inline (greyed out) within their vehicle group. Reversible via
  "Unarchive" action that PATCHes `archived_at = null`.
- **Delete** (`DELETE /sessions/:id`) — hard delete. Order of operations inside the route handler:
  1. `SELECT r2_key FROM fixo_media WHERE session_id = :id` — collect storage keys before the
     cascade wipes them. (Note: column is `r2_key` per
     [schema.ts:323](packages/shared/src/db/schema.ts:323), even though the Drizzle field is named
     `storageKey`.)
  2. `DELETE FROM fixo_sessions WHERE id = :id AND user_id = :auth.userId` — DB-level CASCADE
     removes `fixo_reports`, `fixo_media`, `fixo_obd_codes`, `fixo_message_events` rows (FKs are
     added/altered to `ON DELETE CASCADE` in the same migration — see §7).
  3. Best-effort `supabase.storage.remove(keys)` for the collected media files. Failure here logs a
     warn but does not roll back step 2 — the DB is the source of truth, orphaned blobs are harmless
     and cheaper to GC later than to keep alive.

  Confirmation dialog required, uses destructive-color shadcn button.

## 6. Agent context management

### 6.1 New entry shape

```ts
// apps/agent/src/fixo/build-context.ts (new)
export async function buildAgentContext(opts: {
  sessionId: number;
  latestMessages: ModelMessage[]; // already in model-message form
  uiMessages: UIMessage[]; // raw UI messages, used to extract stable ids
}): Promise<{ systemPrompt: string; modelMessages: ModelMessage[] }>;
```

**Logic** (the entire body runs inside a single transaction with `SELECT ... FOR UPDATE` on the
session row, mirroring [/complete:64](apps/gateway/src/routes/fixo/complete.ts:64) — see §6.5 for
the concurrency rationale):

1. `SELECT summary, last_summarized_message_id FROM fixo_sessions WHERE id = :sid FOR UPDATE`.
2. Find the cursor index in `uiMessages` by scanning for the message whose `.id` matches
   `last_summarized_message_id` (or 0 if null). Stable id resolves codex review #3 — array position
   drifts when hydration paths prepend/mutate parts.
3. Compute `unsummarizedMessages = uiMessages.slice(cursorIndex)`.
4. Estimate input tokens of `unsummarizedMessages + summary` using a real tokenizer (see §6.2). If
   the tokenizer is unavailable in the runtime, fall back to `chars / 3.5` and log a
   `fixo.compact.estimator.degraded` warning so we know we are in fallback mode.
5. Trigger summarization if `estimatedTokens > COMPACT_THRESHOLD` OR
   `unsummarizedMessages.length > KEEP_RECENT_COUNT * 2`.
6. If triggered:
   - `messagesToFold = unsummarizedMessages.slice(0, unsummarizedMessages.length - KEEP_RECENT_COUNT)`
     (UIMessage[])
   - Call `runSummarizer({ previousSummary, messagesToFold })` — converts UIMessage to
     summarizer-friendly form internally.
   - `UPDATE fixo_sessions SET summary = $newSummary, last_summarized_message_id = $messagesToFold.at(-1).id WHERE id = :sid`.
7. Assemble:
   - `systemPrompt = SYSTEM_PROMPT + (summary ? "\n\n## Known facts so far\n" + summary : "")`
   - `modelMessages = latestMessages.slice(-KEEP_RECENT_COUNT)` — since `convertToModelMessages`
     preserves 1:1 ordering, taking the last N from `latestMessages` corresponds to the last N
     entries of `uiMessages` (which is what the agent should see).
8. COMMIT.

**Call site:**

```ts
// apps/gateway/src/routes/fixo/chat.ts (after the existing hydrate-media block)
const latestMessages = await convertToModelMessages(messages);
const { systemPrompt, modelMessages } = await buildAgentContext({
  sessionId: parsedSessionId,
  latestMessages,
  uiMessages: messages,
});
const result = runFixoAgent({ systemPrompt, modelMessages, userId });
```

### 6.2 Constants and tokenizer

```ts
const COMPACT_THRESHOLD = 30_000; // input tokens
const KEEP_RECENT_COUNT = 12; // raw messages preserved
const SUMMARIZER_MODEL = "gemini-2.5-flash";
```

**Tokenizer:** prefer a real count over the original `chars / 4` heuristic (codex review #11 — tool
outputs, reasoning parts, signed URLs, file parts all skew the heuristic in different directions,
making compaction triggering unpredictable).

Order of preference, picking the first that works in the Deno runtime:

1. AI SDK v6's `countTokens` if exposed for the configured Google provider.
2. `@google/generative-ai`'s `countTokens` REST call (~50ms, cached per-session via in-memory LRU
   keyed by message-id list hash).
3. `js-tiktoken` cl100k\_base — close-enough proxy for Gemini, no network.
4. `chars / 3.5` fallback — same shape as before, slightly more conservative than `/4`.

The plan phase will pick exactly one based on Deno-runtime availability.

### 6.3 Summarizer prompt

```
You are a context compactor for Fixo, a car-diagnosis assistant. Fold the
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

Output: one terse markdown bullet list under 800 tokens. No prose.
```

**D1 (decision, 2026-05-04):** the previous draft told the summarizer to drop photo/audio mentions
entirely, on the assumption that hydration would re-attach them every turn. That assumption is
wrong: [hydrate-media.ts:139](apps/gateway/src/routes/fixo/lib/hydrate-media.ts:139) marks
`hydrated_at` and skips already-hydrated rows on subsequent turns. After compaction the agent would
forget every previously-uploaded image. The prompt above keeps a textual residue so the agent
retains the _content_ of uploaded evidence even after the file parts age out.

### 6.4 Manual compact

`POST /sessions/:id/compact`:

- Forces summarization regardless of threshold (folds everything except the last `KEEP_RECENT_COUNT`
  messages).
- Same transaction shape as §6.1 — `SELECT FOR UPDATE` + summarize + write inside one transaction.
- Returns `{ summary, lastSummarizedMessageId }`. UI shows a toast "Compacted N messages."
- The chat-page transcript is **not** cleared. The user still sees every message; only the agent's
  view is condensed.

UI: a small "Clean up context" button in the chat header next to the "Report" button.

### 6.5 Failure modes and concurrency

| Failure                                   | Behavior                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summarizer call errors / times out        | log warn; `buildAgentContext` falls back to sending all `latestMessages` for this turn; next turn retries.                                                                                                                                                                                                                              |
| Concurrent /task vs /task on same session | both block on `SELECT FOR UPDATE`; second waits for the first to commit. Only one summarize+write happens per concurrent burst. Cost: ~2-3s serialization tail when summarization is actually triggered. Acceptable because (a) Gemini 2.5 Flash is fast and (b) the alternative is silent corruption of the summary (codex review #2). |
| Concurrent /task vs /compact              | same lock, same serialization.                                                                                                                                                                                                                                                                                                          |
| Tokenizer unavailable                     | log `fixo.compact.estimator.degraded`; use `chars / 3.5` fallback; spec author follows up to wire a real tokenizer in the next sprint.                                                                                                                                                                                                  |
| Cursor drift (codex review #3)            | not possible: cursor is `last_summarized_message_id` (stable UIMessage id), not array index. Hydration prepending synthetic messages does not invalidate the cursor — we look up by id, not position.                                                                                                                                   |

### 6.6 Observability

Two log events (logtape, no Prometheus yet):

- `fixo.compact.triggered` — `{ sessionId, messagesFolded, beforeTokens, afterTokens }`
- `fixo.compact.serialized_wait_ms` — time spent waiting on `SELECT FOR UPDATE` per turn
- `fixo.compact.estimator.degraded` — fired once per session when tokenizer falls back

Review distribution after one week to retune `COMPACT_THRESHOLD` if needed.

## 7. Migration

Single migration `0016_session_b_model.sql`, executed in one transaction:

```sql
BEGIN;

-- 1. Create fixo_reports (with ON DELETE CASCADE on session_id)
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

-- 2. Create fixo_message_events
CREATE TABLE fixo_message_events (
  user_message_id text  PRIMARY KEY,
  user_id         uuid  NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES fixo_sessions(id) ON DELETE CASCADE,
  month           date  NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixo_msg_events_user_month ON fixo_message_events(user_id, month);

-- 3. Alter existing FKs to CASCADE on delete so the DELETE /sessions route
--    can rely on a single DELETE FROM fixo_sessions ... wiping dependents.
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
--
--    D2 (decision, 2026-05-04): we drop legacy customer-only sessions. Their
--    `result` column is lost when we DROP it in step 8 — there is no
--    production user base to migrate, and the alternative (nullable user_id
--    on reports + customer_id rescue path) preserves zero real value while
--    permanently complicating the schema for SaaS-targeted use.
--
--    Authenticated user_profiles-backed sessions are migrated faithfully.
INSERT INTO fixo_reports (
  session_id, user_id, result, vehicle_snapshot, media_snapshot,
  message_count, generated_at
)
SELECT
  s.id,
  s.user_id,
  s.result,
  -- vehicle snapshot: pull current vehicle row (best effort; null if no link)
  to_jsonb(v.*),
  -- media snapshot: array of { id, type, signedUrl=null, transcription, createdAt }.
  -- Signed URLs are re-generated on read for backfilled rows; a null here means
  -- "regenerate at PDF render time".
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

-- 7. Backfill titles from first user message text part (defensive against
--    non-text first parts: COALESCE to the literal fallback).
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

This migration is **not reversible**. Verification before prod:

- Run on staging clone; assert
  `count(fixo_reports) == count(fixo_sessions WHERE result IS NOT NULL AND user_id IS NOT NULL)`
  pre-drop.
- `pg_dump` of `fixo_sessions` and `fixo_reports` taken immediately before prod migration.

Single-PR migration is acceptable because Fixo has no production users yet (per discussion
2026-05-04).

**Note on auto-archive:** the prior draft auto-archived all `status='complete'` sessions.
**Removed** — codex review #12 correctly flagged this as a product decision masquerading as
migration. With `/history` deleted (§5.1) and archive being a sidebar toggle, completed sessions
naturally live in the active list keyed by `last_message_at`. If a user truly does not want a
finished session in their sidebar, they can archive it manually.

### 7.1 Files deleted

```
apps/gateway/src/routes/fixo/lib/session-lifecycle.ts            (entire file)
apps/fixo-web/src/app/(app)/history/page.tsx                     (route + page)
```

### 7.2 Files modified (high level)

```
packages/shared/src/db/schema.ts                  schema changes per §4
apps/gateway/src/routes/fixo/sessions.ts          add PATCH, DELETE, /reports list, ?include_archived
apps/gateway/src/routes/fixo/chat.ts              eager session create, title gen, message events insert, last_message_at bump, buildAgentContext call site
apps/gateway/src/routes/fixo/complete.ts          insert into fixo_reports (with vehicle + media snapshot) instead of update fixo_sessions
apps/gateway/src/routes/fixo/reports.ts           PDF route reads vehicle_snapshot + media_snapshot from fixo_reports, not from session
apps/gateway/src/routes/fixo/input.ts             continue gating media as plus-only (unchanged), but route through new tier middleware (see §8)
apps/gateway/src/middleware/fixo/tier.ts          rewrite: requireTextQuota, requireMediaTier, requireReportQuota
apps/agent/src/fixo/agent.ts                      accept systemPrompt parameter (replaces SYSTEM_PROMPT import)
apps/agent/src/fixo/build-context.ts              new
apps/agent/src/fixo/summarizer.ts                 new
apps/fixo-web/src/components/Sidebar.tsx          add ChatList integration, vehicle grouping
apps/fixo-web/src/components/chat/ChatList.tsx    new (groups by vehicle)
apps/fixo-web/src/components/chat/ChatListItem.tsx new
apps/fixo-web/src/components/chat/VehicleGroupHeader.tsx new
apps/fixo-web/src/components/chat/NewChatButton.tsx new
apps/fixo-web/src/components/chat/RenameDialog.tsx new
apps/fixo-web/src/components/chat/DeleteConfirmDialog.tsx new
apps/fixo-web/src/app/(app)/chat/page.tsx         simplify — bootstrap moves to [id] route
apps/fixo-web/src/app/(app)/chat/[id]/page.tsx    new — client component with skeleton (NOT server component)
apps/fixo-web/src/hooks/useAgentChat.ts           eager session create on first send via history.replaceState
apps/fixo-web/src/lib/session.ts                  remove lazy-create logic; ensureSession becomes redundant
apps/fixo-web/src/components/BottomNav.tsx        add Chats sheet on mobile
```

## 8. Free-tier quota

```ts
const FREE_LIMITS = {
  // User-role messages (one per unique UIMessage.id), not turn pairs.
  // Idempotent: client retries / network jitter do not double-count.
  userMessagesPerMonth: 5,
  reportsPerMonth: 1,
};
```

### 8.1 Tier middleware shape (rewrite of [`tier.ts`](apps/gateway/src/middleware/fixo/tier.ts))

Three orthogonal gates, each a self-contained function returning `Response | null`:

```ts
// requireTextQuota: counts unique user_message_ids from fixo_message_events
//                   for the current month. INSERT is performed by the caller
//                   in the same /task transaction (see §4.3 write path); this
//                   function only reads.
async function requireTextQuota(auth: AuthContext): Promise<Response | null>;

// requireMediaTier: photo / audio / video / OBD upload — plus-only. Behavior
//                   identical to today, but factored out of the legacy
//                   checkFreeTierLimit function so its semantics are local.
async function requireMediaTier(auth: AuthContext, mediaType: string): Promise<Response | null>;

// requireReportQuota: counts fixo_reports rows for the current month.
async function requireReportQuota(auth: AuthContext): Promise<Response | null>;
```

### 8.2 Endpoint gating

| Endpoint                      | Gate                                    | Counter source                                                      |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `POST /task`                  | `requireTextQuota`                      | `count(fixo_message_events WHERE user_id AND month)`                |
| `POST /sessions/:id/input`    | `requireMediaTier(mediaType)`           | n/a — Plus-only                                                     |
| `POST /sessions/:id/complete` | `requireReportQuota`                    | `count(fixo_reports WHERE user_id AND generated_at >= month_start)` |
| `POST /sessions`              | (none) — empty session creation is free | n/a                                                                 |
| `POST /sessions/:id/compact`  | (none) — manual maintenance, not chat   | n/a                                                                 |
| `PATCH /sessions/:id`         | (none)                                  | n/a                                                                 |
| `DELETE /sessions/:id`        | (none)                                  | n/a                                                                 |

### 8.3 Idempotency mechanics

The `fixo_message_events` table (§4.3) makes counting exact-once on the user-message id. POST /task
entry path:

1. Read latest message id from the request body (`messages[messages.length - 1].id`).
2. `INSERT ... ON CONFLICT DO NOTHING RETURNING user_message_id`.
3. If RETURNING produced a row → it's a new message → run quota check
   `count(fixo_message_events WHERE user_id AND month)`. If over limit, ROLLBACK the INSERT and
   return 403.
4. If RETURNING was empty → it's a replay/retry → skip the quota check (already counted on first
   try) and proceed.

This replaces the original onFinish-based counter pattern, which codex review #4 correctly
identified as both lossy (process death between finish and write) and double-countable (client
retry).

## 9. Testing

### 9.1 Integration (Deno test + Supabase test schema)

- New session → eager create on first send → URL upgrades to `/chat/[id]` via `history.replaceState`
  → in-flight stream survives the URL change → title auto-generates within ~3s
- `fixo_message_events`: same user_message_id POSTed twice does not double-count
- 30K-token threshold (real tokenizer) triggers compaction; `summary` populated;
  `last_summarized_message_id` set to the stable id of the last folded message; next `/task` sees
  only summary + last 12 raw messages
- Hydration prepending a synthetic evidence message does NOT advance the cursor inappropriately
  (regression test for codex review #3)
- `POST /sessions/:id/compact` works regardless of threshold; concurrent `/task` is serialized
  (assert `fixo.compact.serialized_wait_ms` log fires)
- `POST /sessions/:id/complete` creates a `fixo_reports` row with `vehicle_snapshot` and
  `media_snapshot` populated; session row unchanged
- After report creation, deleting a `fixo_media` row or editing the `vehicles` row does NOT change
  the rendered PDF (snapshot integrity)
- Multiple `/complete` calls create multiple report rows; `GET /sessions/:id/reports` lists them
  DESC by `generated_at`
- `PATCH /sessions/:id { archived_at }` excludes from default `GET /sessions`; visible with
  `?include_archived=true`
- `PATCH /sessions/:id { title }` sets `title_is_user_set = true`; auto-titler skips it on
  subsequent runs
- `DELETE /sessions/:id` cascades to reports, media, obd_codes, message_events; storage cleanup runs
- Sidebar grouping: 3 sessions across 2 vehicles + 1 unassigned → 3 groups in the response, each
  correctly populated, sorted within by `last_message_at DESC`
- Free-tier user: 5 messages permitted, 6th rejected with 403; same response shape as today
- Plus user: 100 messages permitted, no quota check overhead
- Compaction summarizer prompt regression: feed a fixture conversation with a photo + OBD code +
  symptom description through `runSummarizer`; assert all three appear in output bullets (D1)

### 9.2 Unit

- `buildAgentContext`: no-summary, partial-summary, threshold-not-hit, threshold-hit-this-turn,
  hydration-mutated-messages-array cases
- `estimateTokens`: empirical accuracy on a sample of real messages (text-only, mixed text+tool,
  mixed text+file)
- `summarizer`: golden-output test (input messages → expected key facts present in output, including
  media descriptions)
- `requireTextQuota` / `requireMediaTier` / `requireReportQuota`: each in isolation, including
  200/403 paths

### 9.3 Migration

- Run `0016_session_b_model.sql` on staging clone of prod schema
- Assert
  `count(fixo_reports) == count(fixo_sessions WHERE result IS NOT NULL AND user_id IS NOT NULL)`
- Assert legacy `customer_id`-only sessions are NOT migrated to reports (their `result` column is
  lost — D2 explicit decision)
- Assert `messages` column is intact (no rows lost)
- Assert `last_message_at` is populated for all rows (defaults to `created_at` if no message
  timestamps)
- Assert no auto-archive happened (`archived_at IS NULL` for all migrated rows)

### 9.4 Manual QA checklist (lifted into the implementation plan)

- Mobile `Chats` BottomNav tab opens Sheet with full ChatList
- Sidebar groups: vehicle headers collapsible, "Unassigned" group always last
- "Show archived" toggle reveals greyed-out archived sessions in their vehicle groups
- Delete confirmation dialog wording mentions reports + photos will be lost
- Title-gen failure shows truncated message preview, never a blank entry
- Offline → online: localStorage path resumes correctly when network returns
- First-send: typing fast and hitting send before sidebar finishes animating still produces a valid
  /chat/[id] URL with the message in flight
- Free-tier user: hits message limit at 5, hits report limit at 1, sees correct upgrade message
- Compact button: clicking it on a long conversation shows a "Compacted N messages" toast and the
  conversation visually unchanged

## 10. Open questions

None blocking. Defer to plan/implementation:

- Exact SWR keys and revalidation strategy for ChatList (probably `/sessions` with
  `revalidateOnFocus: false`)
- Storage cleanup invocation pattern in the DELETE route (likely a single Supabase storage `remove`
  call with an array of keys)
- Whether `/chat/[id]` should 404 or redirect to `/chat` for archived sessions accessed by URL
  (lean: navigate but show "Archived" badge in header)
- Pick exactly one tokenizer from §6.2's preference list during plan phase

## 11. Out of scope (V2)

- Cross-session full-text search
- Tags / folders / pinning beyond vehicle grouping
- Project memory — facts about a vehicle persisting into every new chat about that vehicle (T2/T3
  from the brainstorming session)
- Real-time multi-device sync (WebSocket / pusher)
- Vector retrieval across sessions
- Structured fact extraction (instead of free-text summary)
- Tool-result clearing (Anthropic-style `clear_tool_uses_*`)
- Per-shop SaaS prompt customization (multi-tenant tier)
- Plus → Free downgrade behavior mid-month (Stripe webhook handling out of scope)
- Long-conversation `messages` array trimming — once a session crosses tens of thousands of
  messages, the JSONB column becomes a perf concern. V2: drop already-summarized messages from the
  column, keep only the summary + recent window.

## 12. References

- [Vercel/ai #10864 — Conversation compaction with AI SDK v5](https://github.com/vercel/ai/discussions/10864)
- [Anthropic — Context engineering: memory, compaction, and tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [LangMem — Long-context summarization guide](https://langchain-ai.github.io/langmem/guides/summarization/)
- [mem0 — LLM chat history summarization best practices](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025)
- [Maxim — Context window management strategies for long-context AI agents](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/)
- [Cline — `/smol` compaction command pattern](https://www.augmentcode.com/tools/cline-vs-cursor)
