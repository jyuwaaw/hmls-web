# Fixo Self-Serve API Onboarding — Design

- Date: 2026-06-21
- Status: Design / awaiting review
- Branch: `spinsirr/fixo-self-serve`

## One line

Let an interested developer/shop sign in and generate their own Fixo API key — then immediately
point their own agent (MCP client) at `/v1/mcp` — with no human in the loop. This removes the manual
`mint-fixo-key.ts` step, which is an artificial funnel that drops every interested user who hits the
"ask someone to mint a key" wall.

## Why now

The platform (REST `/v1/diagnose` + MCP `/v1/mcp`, key-gated) is LIVE, but the ONLY way to get a key
is an operator running `mint-fixo-key.ts` via Infisical. That manual gate IS the funnel: interest →
wall → drop. Self-serve closes the interest→usage gap.

Self-serve also flips the deferred **external-key hard gate** from "later" to "the enabler": the
moment users mint their own keys, those keys are external / untrusted, so the safety rails (rate
limiting, input bounds, outcome ownership) must ship WITH the self-serve flow, not after.

## Locked decisions

- **Audience + auth:** reuse fixo.ink's existing Supabase auth. Any signed-in user can mint a key
  from a new "API keys" section in the signed-in app. No separate developer portal (YAGNI — split
  out later if the developer audience grows). (`authenticateRequest` already yields `userId` =
  Supabase `auth.users.id`.)
- **External surface = MCP only.** Externally we offer the MCP endpoint (`/v1/mcp`) — the
  agent-native surface that matches "bring your own agent." The REST `/v1/diagnose` was the stepping
  stone; it has no internal consumer (HMLS uses the brain in-process; fixo.ink uses the `/task` chat
  route), so it stays DORMANT/unadvertised — not removed, not promoted to self-serve users.
  Self-serve keys are "MCP keys." (Both endpoints share the `/v1/*` key gate, so a key technically
  works on either; hard per-endpoint key scoping is deferred — for now MCP is simply the only
  documented external surface.)
- **Pricing:** FREE, rate-limited tier. No payment/credits to start — charging upfront would
  re-create the funnel friction. Monetization (credits/tiers) is a later layer, deferred.
- **Rate-limit storage:** DB fixed-window counter (reuses the existing Postgres; accurate; the one
  extra counter write is dwarfed by the ~5s LLM call). NOT in-memory (Deno Deploy runs multiple
  isolates → per-isolate counters leak).

## Architecture

### Key-issuance endpoints (gateway, session-authed)

Mounted under the existing fixo session-auth (`requireAuth` → `authenticateRequest`), NOT the
api-key gate — you authenticate as a logged-in user to manage your keys:

- `POST /keys` `{ label? }` → mints a key for `auth.userId`, returns the plaintext ONCE
  (`{ key, id, label }`). Stores only the SHA-256 hash (existing `generateApiKey`/`hashApiKey`).
- `GET /keys` → lists the caller's keys: `{ id, label, createdAt, lastUsedAt,
  revoked }[]` — NEVER
  the plaintext/hash.
- `DELETE /keys/:id` → revokes (sets `revoked_at`); only if the key belongs to `auth.userId`.

### Schema changes (hand-written migration)

- `fixo_api_keys` + `user_id uuid` (→ `userProfiles`/auth user). Owner of the key; powers
  list/revoke scoping. (Manually-minted keys have NULL `user_id`.)
- `fixo_predictions` + `api_key_id uuid` (→ `fixo_api_keys`). Which key created the prediction;
  powers `record_outcome` ownership.

### Safety gate (required — keys are now external/untrusted)

- **Input bounds** on `/v1/*`: `symptom` ≤ 2000 chars, `dtcs` ≤ 20 items, request body ≤ 32 KB (zod
  `.max(...)` + a body-size middleware). Caps the per-call cost surface.
- **Per-key rate limit:** DB fixed-window counter keyed by `(api_key_id,
  window)`. Default free
  tier (config-tunable, start conservative since each call is an LLM inference): **20 req/min + 200
  req/day**. Over → HTTP 429 with a JSON-RPC-friendly error. Applied in the api-key middleware after
  key verification.
- **`record_outcome` ownership:** the calling key must own (have created via `diagnose`) the
  `prediction_id` — checked against `fixo_predictions.api_key_id`. Mismatch → in-band tool error
  (MCP) / 403 (REST). Prevents one key overwriting another's calibration outcomes.

### UI (fixo-web, signed-in area)

An "API keys" page: create a key (show once + copy button), list keys (label / created / last used /
revoke), and a short **getting-started** block — how to point an MCP client (Cursor / Claude Desktop
/ the AI SDK) at the MCP endpoint (`https://api.fixo.ink/v1/mcp`) with the
`Authorization: Bearer
<key>` header. (REST `/v1/diagnose` is intentionally NOT shown — MCP is the
external surface.)

## Data flow

sign in (fixo.ink) → "API keys" page → `POST /keys` → key shown once → copy → point an MCP client at
`/v1/mcp` with the key → tool calls are rate-limited + input-bounded; the `diagnose` tool stamps the
prediction with the key; `record_outcome` only accepts that key.

## Error handling

- Issuance without a session → 401. Revoke/list of someone else's key → 404 (not 403, to avoid id
  enumeration).
- Rate limit exceeded → 429 (REST) / JSON-RPC error (MCP), with a retry hint.
- Input over bounds → 400 with the offending field.
- Plaintext is shown ONCE; lost = revoke + regenerate (never recoverable).

## v1 scope

Mint / list / revoke endpoints + the schema changes + the safety gate (bounds, rate limit, outcome
ownership) + the "API keys" page with a getting-started snippet.

**Deferred (NOT v1):** usage dashboards/analytics; monetization (credits/tiers/metering); multiple
scopes or per-tool permissions; org/team shared keys; a standalone developer portal/subdomain;
email-on-key-events.

## Risks / open items (for the plan to pin)

- Exact fixo-web signed-in route + nav location for the "API keys" page (the plan verifies against
  the current fixo-web structure).
- Rate-limit window semantics (fixed window is simplest; a burst at a window edge can briefly exceed
  — acceptable for free-tier abuse protection; revisit with a sliding window or token bucket if/when
  metering matters).
- The free-tier numbers (20/min, 200/day) are first-guess; tune from real usage. Keep them in one
  config constant.
- Manually-minted keys (NULL `user_id`, no `api_key_id` on their predictions): list/revoke UI won't
  show them (fine — operator keys), and `record_outcome` ownership must treat a NULL-owner
  prediction sensibly (allow, or scope by the same key) — the plan specifies.
