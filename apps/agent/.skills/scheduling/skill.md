---
name: scheduling
description: >
  This skill should be used whenever the customer wants to book service,
  pick a time, reschedule, or cancel — and any time you need to know
  what stage of the lifecycle an order is at. Covers the full order
  state machine, the chat-flow path, the legacy portal/PDF path, and
  the auto-dispatch behavior (Uber-style mechanic assignment).
---

# Scheduling Skill

The customer-chat experience is a **single continuous conversation** that ends with a booking
request. There is no "shop must send the estimate" pause and no "customer must approve" step — both
are folded into the chat. The shop's only required interaction is a final Confirm click on the
assembled package.

## Order Lifecycle (state machine — 7 states)

```
draft ──► estimated ──► approved ──► in_progress ──► completed
  │ ╲        │  ▲          │              │
  │  ╲       │  └─(pullback: shop edits a sent estimate → back to draft)
  │   ╲      ▼             ▼              ▼
  │    ╲  declined     cancelled      cancelled
  │     ╲    │
  │      ╲   └─► draft (re-revise)
  │       ╲
  │        ╲──► approved  (walk-in shortcut, requires customer-authorization
  │              evidence — chat consent / text / call / in-person)
  ▼
cancelled
```

- **Scheduling is a property, not a status.** `approved` + `scheduledAt` + assigned mechanic IS the
  confirmed booking. There is no `scheduled` status.
- **`draft → approved`** is the chat-flow / walk-in shortcut. The customer picks a time and a
  mechanic gets auto-assigned, all while the order stays in `draft`. The shop's "Approve & confirm"
  click promotes it straight to `approved` (with authorization evidence recorded).
- **`draft → estimated → approved`** is the review-and-send path used for non-chat customers (PDF
  link, portal). The customer approves via a separate /portal endpoint.
- **Revision = pullback to `draft`.** Editing a sent (`estimated`) order pulls it back to `draft`;
  re-sending returns it to `estimated`. There is no `revised` status.

## Chat-flow contract

The customer chat ALWAYS targets the chat shortcut. Do not try to send the estimate, do not call any
approve tool — those don't exist on the chat side anymore. The flow is:

1. **Build the estimate** — `create_order` (lands at `draft`). The EstimateCard shows the customer
   the full price breakdown right in the chat.
2. **Pick a time** — `get_availability` → customer picks a slot in the in-chat picker →
   `schedule_order`. The order stays in `draft`; the tool sets `scheduledAt` + auto-assigns a
   mechanic via `providerId`.
3. **Hand off to shop** — Tell the customer: "Got it — appointment requested for [time]. Our team
   will give it a final review and confirm shortly." The shop sees the complete package in the admin
   dashboard and clicks one button to confirm.

The customer's `schedule_order` call IS the affirmative consent — it's audited via the
`schedule_attached` event. There is no separate "approve" step.

## Available Tools

- `get_availability` — open slots for the next 7 days. Renders the date + time picker in the chat.
  **Do not** ask the customer for a preferred time before calling this — the picker IS the question.
- `schedule_order` — pin appointment time on an existing order. Status never changes.
  - Works on `draft` / `estimated` (tentative slot pending shop review)
  - Works on `approved` / `in_progress` (sets or reschedules the confirmed booking)
  - **Never pass `durationMinutesOverride`** — staff-only override; the customer-visible duration is
    fixed by the order's labor items.
- `cancel_booking` — customer cancels a booked appointment (order `approved` with a scheduled time).
  Once status is `in_progress` (mechanic on the job), cancellations must go through the shop
  directly.
- `cancel_order` — customer aborts a `draft` (chat in progress, changed mind), `estimated`, or
  `approved` order.

## Auto-Dispatch Behavior

`schedule_order` triggers `autoAssignProvider()` after the time is set. The picker:

1. Eligible mechanics: `is_active=true` AND no `blocked_range` overlap
2. Customer-history preference: most recent `completed` order's mechanic (if eligible)
3. Round-robin fallback: eligible mechanic with fewest scheduled jobs in the next 7 days

If no mechanic is eligible (every active one busy at that exact slot), the order keeps
`providerId = null` and the shop dispatches manually. The tool's response message reflects this —
the agent should pass that through to the customer verbatim, not invent a mechanic name.

## Important Rules

- Never name the assigned mechanic to the customer — internal dispatch detail. The shop will
  introduce them.
- Never ask the customer to pick a mechanic — assignment is automatic.
- Never double-book. The harness's exclusion constraint prevents it; if `schedule_order` fails on
  conflict, call `get_availability` again and offer the updated slots.
- `schedule_order` does not currently take a service location from the customer side. If the address
  is non-default, the shop captures it during admin confirm.

## Service Area

Orange County only: Irvine, Newport Beach, Anaheim, Santa Ana, Costa Mesa, Fullerton, Huntington
Beach, Lake Forest, Mission Viejo.
