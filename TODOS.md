# TODOS

Tracked work deferred from PRs. Each entry includes design context so a future implementer can pick
it up cold.

---

## Dual-metro follow-ups (deferred from the SEO front-door PR, 2026-06-12)

### Terms page still scopes service to "Orange County, California" (P2 — founder sign-off)

`apps/hmls-web/app/(marketing)/terms/page.tsx:43` legal wording under-scopes the actual service area
now that SJ is live. Legal copy — founder decides exact wording (suggest "in California" or naming
both metros). One line.

### Contact page links OC Google profile while claiming dual coverage (P2 — blocked by SJ GBP verification)

`apps/hmls-web/app/(marketing)/contact/page.tsx` map embed + profile link come from `BUSINESS.gmb`
(OC listing). When the SJ Google Business Profile passes verification, set `REGIONS.sj.gmbShareUrl`
and make the contact links region-aware. SJ profile created 2026-06-11, verification pending.

---

## Bug B — PDF report endpoint always returns 400

**What:** `GET /sessions/:id/report` requires `fixoSessions.result` jsonb populated. No code writes
to it. Result: clicking "Report" in fixo-web always returns 400 "Session has no result yet".

**Why:** Closes the diagnostic dogfood loop. Mechanic-side users want a takeaway artifact from each
session.

**Pros:** Working PDF report unlocks the full UX. Validates the agent's diagnosis quality in a
structured form. Distinguishes "session in progress" from "session complete".

**Cons:** Larger than the original 15-min sketch. Needs design work on session-boundary semantics +
structured-output schema + UI.

**Context:**

- Original Plan A (D2 in 2026-04-26 plan-eng-review) said "on streamText.onFinish, write summary to
  fixoSessions.result." Codex correctly flagged this as hand-wavy:
  - `apps/gateway/src/routes/fixo/reports.ts:65-95` reads structured JSON
    `{summary, overallSeverity, issues[], obdCodes[]}`. Agent only streams freeform text.
  - Marking `status='complete'` on every `onFinish` breaks multi-turn — the first clarifying
    question would complete the session, follow-ups would overwrite the result.
- The right fix needs:
  1. Explicit user "I'm done" trigger (button or "finish session" intent), not
     implicit-on-stream-end.
  2. A separate structured-output LLM call (`generateObject` with a Zod schema) on demand, distinct
     from the conversational stream.
  3. Schema:
     `summary: string, overallSeverity: 'critical'|'high'|'medium'|'low', issues: Array<{title, severity, description, recommendedAction, estimatedCost?}>, obdCodes: Array<{code, meaning, severity}>`.
  4. Session-completion semantics: `fixoSessions.status='complete' + completedAt` only set when user
     finalizes. Subsequent activity reopens.
- Until this lands, Plan B (current PR) hides the "Report" button when `fixoSessions.result` is null
  to avoid the user-facing 400.

**Depends on / blocked by:** None. Standalone follow-up PR.

**Rejected alternatives:**

- (A) Bundle into Plan B: rejected as PR-doubling work and deserving its own design conversation.
- (C) Quick-and-dirty: dump full chat transcript into `fixoSessions.result`. Rejected — produces an
  unusable PDF and builds on a bad foundation that would need to be ripped out.

---

## Gemini trailing-orphan: aborted-mid-tool-call turns (P2 — needs replay-safe design)

**What:** A chat turn aborted mid-tool-execution (client disconnect, tab crash, timeout) persists a
UIMessage whose last tool part is `input-available`/`input-streaming` (no result). On the next turn,
`convertToModelMessages` (default) emits an assistant `functionCall` with no matching
`functionResponse`, and Gemini rejects the request: "function response turn must come immediately
after a function call turn." Mirror of the leading-orphan windowing bug fixed in
`apps/agent/src/fixo/build-context.ts` (`trimToUserTurnStart`), but on the tail edge.

**Why not fixed in the windowing PR:** The obvious one-liner
`convertToModelMessages(messages, {
ignoreIncompleteToolCalls: true })` DROPS the incomplete
tool-call. On routes whose agents run non-idempotent mutations — `/chat` + `/staff-chat` expose
`schedule_order` (auto-assigns providers), `modify_order_items`, `add_order_note` — the tool may
have ALREADY executed server-side before the disconnect. Dropping the call lets the model re-call it
on replay → duplicate schedule / duplicate line items / duplicate audit note. Trades a hard
fail-closed (Gemini 400) for silent data corruption. (Codex adversarial finding, 2026-06-13.)
`ignoreIncompleteToolCalls` also only filters `input-*` states, not
`approval-requested`/`approval-responded`, so it doesn't fully establish the "every functionCall has
a functionResponse" invariant.

**Design needed (pick one, per-route):**

- **Abort-aware persistence:** in the `toUIMessageStreamResponse({ onFinish })` handlers
  (`apps/gateway/src/routes/fixo/chat.ts`, `chat.ts`, `staff-chat.ts`), skip persisting when
  `isAborted` is true, or strip the trailing incomplete tool part before persisting.
- **Idempotency keys** on the mutating tools so a replay is a no-op (then
  `ignoreIncompleteToolCalls` becomes safe everywhere).
- **Synthesize an error tool-result** for the incomplete call ("tool aborted, result unknown") so
  the model sees it happened and doesn't blindly re-call.

`fixo/complete.ts` (report summarization, no tools executed) is the one safe place to apply
`ignoreIncompleteToolCalls` directly — no replay risk there.

---

## Credit-deduction race (codex finding #4 from 2026-04-26 plan-eng-review)

**What:** `apps/gateway/src/middleware/fixo/credits.ts:42` `processCredits` is check-then-deduct
without a lock or idempotency mechanism. Two concurrent `/sessions/:id/input` requests on the same
`stripeCustomerId` can both pass the balance check before either calls `deductCredits`, causing
overdraft.

**Why:** Real bug. Exploitable: a user with `balance=5` and `cost=5/upload` who fires two concurrent
uploads ends with `balance=-5` and gets a free upload. Low blast radius at beta volume but
eventually exploitable.

**Pros:** Closes a real billing-correctness hole. Sets up the credit subsystem for higher
concurrency.

**Cons:** Stripe `customers.createBalanceTransaction` doesn't have a native
"decrement-if-sufficient" primitive — fix requires a workaround.

**Context:**

- Repro: two concurrent `POST /sessions/:id/input` with `type=photo`, balance just under
  `2 × required`, both succeed, customer goes negative.
- Fix paths (in increasing complexity):
  1. **DB-cached balance with row lock**: maintain a local `customer_credit_balance` table mirroring
     Stripe.
     `UPDATE ... SET balance = balance - $cost WHERE stripe_customer_id = $id AND balance >= $cost RETURNING balance`
     is atomic. Reconcile with Stripe nightly.
  2. **Stripe idempotency_key**: derive `idempotency_key = hash(customerId, sessionId, mediaId)`.
     Prevents same upload from double-charging on retry but doesn't prevent two different uploads
     from both passing the read-balance check.
  3. **Optimistic with retry**: read balance, attempt deduct, if Stripe reports insufficient
     (retry-once-after-fresh-read).
- Recommended path: (1) for correctness, augmented with (2) for retry-safety. Hold off on (3).

**Depends on / blocked by:** None. Independent of Bug B.

---

## Verify audio/webm as `FileUIPart` (codex finding #8 from 2026-04-26 plan-eng-review)

**What:** Plan B keeps the `analyzeAudioNoise` tool + client-side spectrogram path for audio. We
chose to defer the experiment of "does Gemini 3 Flash via `@ai-sdk/google` accept `audio/webm` as a
`FileUIPart` directly?". If it does, the spectrogram path can be deleted (~70 lines of WebAudio +
the `analyzeAudioNoise` tool ~100 lines).

**Why:** Possible 170-line deletion + cleaner architecture (single multimodal path for all media
types).

**Pros:** Removes a custom client-side audio-processing path. Simplifies the agent's tool surface to
`lookupObdCode + extractVideoFrames + ask_user_question + labor/parts/estimate`. Aligns photo and
audio paths.

**Cons:** Bounded but real experiment. Need a baseline.

**Context:**

- Hypothesis: AI SDK v6's `FileUIPart` with `mediaType: 'audio/webm'` (or `audio/mp3`) routes
  through `convertToModelMessages` → `@ai-sdk/google` → Gemini 3 multimodal input. Gemini 1.5+
  supports audio input for ~9 hours total per request. Gemini 3 Flash Preview should support the
  same.
- Experiment design:
  1. Curate 3-5 vehicle audio samples with known-correct diagnoses (engine knock, belt squeal, brake
     grinding, etc.).
  2. Run each via current spectrogram + `analyzeAudioNoise` path; record diagnosis.
  3. Run each via `FileUIPart` audio path (same agent minus the tool); record diagnosis.
  4. Score: which path identified the issue more accurately? Which gave more useful detail?
- If FileUIPart audio is at parity or better: delete `analyzeAudioNoise` + spectrogram client code.
- If worse: keep spectrogram path indefinitely; document the call.

**Depends on / blocked by:** Plan B merged (the codepaths are stable).

---

## Credit System (still deferred after Phase 11-16 follow-ups)

Most originally-deferred items shipped in this PR. Remaining (still deferred):

### Migrate to Stripe Entitlements (when 2nd paid tier launches)

When Pro is actually live, migrate from `customer.subscription.*` events to
`entitlements.active_entitlement_summary.updated`. Today the `tierFromPriceId` helper +
single-paid-tier setup makes Entitlements overkill, but the SoT-on-Stripe model is the right end
state for ≥2 paid tiers + feature flags.

### Async webhook processing (when scale demands)

Stripe recommends 2xx-then-queue. Today our DB tx is fast (<100ms) so synchronous handling is fine.
Revisit if the Plus monthly renewal spike starts saturating the DB pool — then introduce a
`stripe_events` table + worker.

### Stripe SDK upgrade (20.4.1 → 22.x)

Bump deno.json `stripe` dep, update `STRIPE_API_VERSION` from `2026-02-25.clover` to
`2026-04-22.dahlia`, also update Stripe Dashboard webhook endpoint API version. Likely safe but
needs regression check on every webhook event we handle. Single-purpose PR.

### Restricted API Key (RAK) migration

Stripe Dashboard → Developers → Create restricted key with: Customers (RW), Checkout Sessions (RW),
Billing Portal Sessions (RW), Subscriptions (R), Invoices (R), Charges (R), Webhook Events (R).
Replace `STRIPE_SECRET_KEY` env var. SDK accepts both transparently. Pure ops change.

---

## Fixo Quote-Verifier Mini-Product (P2)

**What:** New fixo flow where a user uploads a photo of a maintenance/repair quote from a shop, and
fixo extracts the line items via vision + returns a verdict (fair / high / very high) compared to
local market averages.

**Why:** Surfaced during /plan-ceo-review of the Speed Wedge 30-day plan (2026-05-14) as a wedge
candidate for the case where Speed Wedge fails to validate at Week 3. Highest LTV scenario (a person
checks every repair quote for the rest of their car-owning life). Reddit can't give local market
averages, ChatGPT can't either. fixo can.

**Pros:**

- Highest LTV per user of the three wedge candidates evaluated in /office-hours
- PDF verdict report is naturally viral (users hand it back to the shop, exposes fixo to mechanics)
- Reuses existing fixo vision + PDF pipeline
  ([apps/agent/src/fixo/tools/](apps/agent/src/fixo/tools))

**Cons:**

- Requires local market price data (labor rate × ZIP + parts markup × region). Data acquisition is
  the actual hard problem, not the agent UX.
- Legal: publishing per-shop prices could draw threats from local shops. Aggregate-only is safer.
- Effort: XL — 4 weeks alone in the speed wedge plan budget couldn't ship it; needs its own runway.

**Context:**

- Surfaced as Approach C in
  [/office-hours design doc 2026-05-14](~/.gstack/projects/hmls-autos-hmls/spenc-spinsirr-pedantic-kilby-a78e57-design-20260514-010011.md).
  Rejected in that session in favor of Speed Wedge.
- Re-surfaced in
  [/plan-ceo-review 2026-05-14](~/.gstack/projects/hmls-autos-hmls/ceo-plans/2026-05-14-fixo-speed-wedge-30day.md)
  as a wedge-switch target. If Speed Wedge kill criteria (Week 2 ChatGPT in ≥80% scenarios at fixo
  quality OR Week 3 SEO 0 impressions) trigger, this is the most natural pivot.
- Data acquisition options to evaluate when picked up:
  - RepairPal/YourMechanic scrape (gray legal area)
  - Crowdsource from r/MechanicAdvice answers (manual, slow)
  - Licensed data from Mitchell 1 or Mitchell ProDemand (expensive, requires shop contract)
  - LLM estimation from olpLaborTimes table + national mean adjusted by ZIP cost-of-living
- Existing `tier-grouped estimate section in diagnostic report` (commit a266c21, PR #64) is the
  closest existing primitive.

**Effort:** XL (human team) → L (CC+gstack)

**Priority:** P2

**Depends on / blocked by:** Speed Wedge 30-day plan completing first. Pick up only if Speed Wedge
kill criteria fire, OR if Speed Wedge succeeds but you want a second wedge to compound retention.

## Notification outbox + retry (from /plan-eng-review Codex outside voice, 2026-07-11)

**What:** All customer/admin emails today are fire-and-forget after the DB transaction commits — no
retry, no outbox, no send-idempotency key. On Deno Deploy a serverless instance can be terminated
after the response is returned, silently dropping the email forever.

**Why:** Pre-existing architecture debt, but the order-lifecycle-collapse design (2026-07-10 design
doc) promotes the "schedule ready" email to a business-critical notification (it replaces the manual
confirm-booking click), so the blast radius of a dropped email grows: order confirmed but customer
never told.

**Pros:** Deterministic delivery for lifecycle-critical emails; retry on transient SMTP/provider
failures; audit trail of send attempts.

**Cons:** Needs an `notification_outbox` table + a worker/cron to drain it — its own PR (~2 days
CC), plus dedup interplay with the `schedule_ready_notified` event marker shipped in PR 2.

**Context:** Codex finding #5 during eng review of the state-machine collapse. Current send path:
`fireNotification` post-commit in `apps/agent/src/services/order-state.ts` (~line 205) and
`apps/agent/src/lib/notifications.ts`. PR 2 of the collapse ships a same-transaction
`schedule_ready_notified` event + partial unique index for dedup — the outbox would reuse that
marker as the enqueue record (state: pending → sent/failed) rather than adding a second mechanism.

**Depends on / blocked by:** Order-lifecycle-collapse PR 2 (the event marker lands there).
**Trigger:** first observed lost lifecycle email, or first external SaaS shop onboarded.

## Preferred-contact follow-ups (from /qa on spinsirr/customer-contact-preference-9f6871, 2026-07-09)

- [x] **Cap `logContactInput.note` length** — `.max(500)` added in
      `packages/shared/src/api/contracts/orders.ts` + test. Fixed by /ship pre-landing review on
      this branch, 2026-07-10.
- [x] **Portal leaks `note_added` internal notes** — pre-existing (NOT introduced by this branch):
      `GET /me/orders/:id` in `apps/gateway/src/routes/portal.ts` returns `note_added` events whose
      metadata carries internal staff notes. `customer_contacted` is now filtered (ISSUE-004 fix); 3
      review specialists converged on inverting to an allowlist (`CUSTOMER_VISIBLE_EVENT_TYPES` next
      to the enum in `packages/shared/src/db/schema.ts`) so future internal event types are
      private-by-default. Do that as part of this fix. Severity: medium. **Fixed in the compliance
      fence PR (2026-07-11): allowlist + `filterCustomerVisibleEvents` (strips metadata/actor) in
      `packages/shared/src/db/schema.ts`, wired into the portal route; tests in
      `apps/gateway/src/routes/portal_test.ts`.**
- [ ] **Index `order_events(order_id, created_at)`** — FK columns aren't auto-indexed; the event
      feed (admin + portal) filters/orders by these and `customer_contacted` grows the table faster.
      Add in a follow-up migration; optionally LIMIT the event fetch. Severity: low (dogfood scale
      today). From /ship performance specialist, 2026-07-10.

## Preferred-contact follow-ups (from /ship red team + Codex, 2026-07-10)

- [ ] **显式清除订单偏好会被 profile fallback 盖回来** — CustomerEditor 把 `contact_preferred` 置
      null 后,徽章 fallback 到 `customers.preferred_contact`,NULL 无法区分「未设置」和
      「明确清除」。要支持 per-order 明确清除需要 'none' 哨兵值(enum 加值 + UI)。当下缓解: admin
      现在可以直接改 profile 偏好(PATCH /admin/customers/:id 已支持,含置 null)。 Severity:
      low(实际场景更多是改成另一渠道而非清除)。
- [ ] **Agent 只回填不覆盖 profile 偏好 — 是否应改为「最新明确表述获胜」** — 设计前提③锁了
      「仅空时回填」(与 phone 一致),但 red team 指出偏好是 consent 语义:客户说「别打电话了」
      应更新默认值。当前缓解:订单快照永远是最新意图 + admin 可改 profile。若要改语义,动
      `resolveCustomer`(order.ts)三处 backfill 守卫。founder 拍板。Severity: medium(语义决策)。
- [ ] **CustomerEditor 全量覆写五个联系字段(无脏字段跟踪/并发守卫)** — 编辑器打开期间 agent revise
      写入的 contact_preferred 会被 open-at-time 的旧值静默覆盖。pre-existing 模式
      (另外四个字段同样),nullable 字段让误覆盖更易发生。修法:只发 dirty 字段,或 PATCH direct-updates
      加 updatedAt 乐观并发检查。Severity: low-medium。
