# Order detail page — status-driven UI

**Date:** 2026-05-22 **Author:** Spencer Zhao (with Claude) **Status:** Design — awaiting review

## Problem

Admin order detail page (`apps/hmls-web/app/(admin)/admin/orders/[id]/page.tsx`, 1213 lines) exposes
the same business actions through multiple parallel UI paths, and the page hand-rolls panel
composition instead of deriving it from order status.

Observed redundancy:

| UI entry                                      | Real call                                      | Lands at      |
| --------------------------------------------- | ---------------------------------------------- | ------------- |
| Appointment "Confirm booking"                 | `transitionStatus("scheduled")`                | `→ scheduled` |
| Actions "Schedule"                            | `transitionStatus("scheduled")`                | `→ scheduled` |
| Draft banner "Approve & confirm"              | `transitionStatus("scheduled")`                | `→ scheduled` |
| Appointment "Reject booking"                  | `transitionStatus("cancelled", reason)`        | `→ cancelled` |
| Actions "Cancel"                              | `transitionStatus("cancelled", reason)`        | `→ cancelled` |
| Appointment "Reschedule" + Details "Reassign" | open `SetTimeDialog` / `ReassignBookingDialog` | (dialogs)     |

The code mirror of this: `BookingPanel` keeps its own `bookingBusy` state alongside
`useOrderMutations.transitioning`; `handleBookingConfirm` / `handleBookingReject` are near-copies of
the generic `handleTransition`. Three panel-visibility predicates (`SHOW_ESTIMATE_PANEL_STATUSES`,
`SHOW_QUOTE_PANEL_STATUSES`, `SHOW_BOOKING_PANEL_STATUSES`) decide layout imperatively from status,
but each panel still hardcodes which buttons to put inside.

**Root cause** (agreed during brainstorming): the action concept has no single source of truth, and
the information architecture (which panel exists, what it contains) is not derived from the order
state machine.

## Goal

Each `OrderStatus` declaratively describes:

1. Which actions are candidates at this status.
2. Which sections of the main column are editable.

The right column collapses to one `OrderOpsPanel` that renders from the declaration; the main column
becomes an `OrderSectionsRegion` that renders sections in fixed order, each section read-only or
editable per the declaration.

After this change, adding a new status transition or a new editable area means:

- Add the descriptor in one of two registries.
- Reference its id in the relevant `StatusProfile`.

No JSX edits anywhere else.

## Non-goals

- Customer-facing portal pages — out of scope (only admin order detail).
- Staff agent re-using profiles to answer "what can I do on this order" — `profiles.ts` lives in
  `packages/shared/` to enable this later, but the agent code is untouched in this PR.
- Stripe / auto-capture wiring — dormant, stays dormant.
- New visual style — keep current dark card aesthetic; only one new layout (Schedule section) is
  genuinely new design.

## Architecture

### Type model

```ts
// packages/shared/src/order/profiles.ts — pure data, no React
export type EditableSection = "items" | "customer" | "schedule" | "notes";

export type ActionId =
  | "send_to_customer" // draft|revised → estimated
  | "approve_estimate" // estimated → approved (admin override of customer)
  | "decline_estimate" // estimated → declined (admin override)
  | "revise_estimate" // declined → revised (re-open after customer decline)
  | "confirm_tentative_booking" // draft → scheduled (chat flow shortcut)
  | "confirm_booking" // approved → scheduled
  | "reject_booking" // approved → cancelled with reason
  | "reassign_mechanic" // dialog; PATCH /orders/:id/schedule
  | "reschedule" // dialog; PATCH /orders/:id/schedule
  | "set_time" // dialog; PATCH /orders/:id/schedule (alias of reschedule when scheduledAt is null)
  | "start_job" // scheduled → in_progress
  | "complete_job" // in_progress → completed
  | "cancel_order" // any non-terminal → cancelled
  | "mark_paid"; // non-transition; POST /orders/:id/payment

export type StatusProfile = {
  status: OrderStatus;
  actions: ActionId[]; // candidates; final visibility decided by ActionDescriptor.visible(order)
  primary?: ActionId; // hint for banner button + panel prominence
  editableSections: EditableSection[];
};

export const STATUS_PROFILES: Record<OrderStatus, StatusProfile> = {
  draft: {
    status: "draft",
    actions: [
      "send_to_customer",
      "confirm_tentative_booking",
      "reassign_mechanic",
      "reschedule",
      "cancel_order",
    ],
    primary: "send_to_customer",
    editableSections: ["items", "customer", "schedule"],
  },
  estimated: {
    status: "estimated",
    actions: ["approve_estimate", "decline_estimate", "cancel_order"],
    editableSections: ["items", "customer"],
  },
  declined: {
    status: "declined",
    actions: ["revise_estimate"],
    primary: "revise_estimate",
    editableSections: [],
  },
  revised: {
    status: "revised",
    actions: ["send_to_customer", "cancel_order"],
    primary: "send_to_customer",
    editableSections: ["items", "customer"],
  },
  approved: {
    status: "approved",
    actions: ["set_time", "reassign_mechanic", "confirm_booking", "reject_booking"],
    primary: "confirm_booking",
    editableSections: ["schedule"],
  },
  scheduled: {
    status: "scheduled",
    actions: ["start_job", "reschedule", "reassign_mechanic", "cancel_order"],
    primary: "start_job",
    editableSections: ["schedule"],
  },
  in_progress: {
    status: "in_progress",
    actions: ["complete_job", "cancel_order"],
    primary: "complete_job",
    editableSections: [],
  },
  completed: {
    status: "completed",
    actions: ["mark_paid"],
    primary: "mark_paid",
    editableSections: [],
  },
  cancelled: { status: "cancelled", actions: [], editableSections: [] },
};

// Notes on profile choices:
//   - `estimated` has no `primary` because admin is normally waiting on the
//     customer (approval comes via portal). The admin actions are overrides.
//   - `mark_paid` is gated to `completed` in the UI even though the server
//     accepts payment recording from `approved` onward (see PAYMENT_ALLOWED_STATUSES).
//     If a shop later wants deposit-on-approval, widen the profile entries.
//   - `editableSections` must align with server-side editability:
//       * "items" / "customer" require the order to be in EDITABLE_STATUSES
//         (= draft, revised, estimated). Profile is consistent.
//       * "schedule" is gated by the schedule endpoint itself (approved or
//         scheduled, plus draft for the chat flow). Profile is consistent.
```

```ts
// apps/hmls-web/lib/order-actions.ts — UI tier
export type ActionVariant = "primary" | "secondary" | "danger";

export type ActionContext = {
  order: Order;
  transitionStatus(next: OrderStatus, reason?: string): Promise<void>;
  setSchedule(at: Date, providerId: number): Promise<void>;
  markPaid(method: PaymentMethod, reference?: string): Promise<void>;
  openDialog(id: DialogId): void;
  askReason(opts: { title: string; description?: string }): Promise<string | null>;
  mutate(): Promise<void>;
};

export type DialogId = "reassign" | "set_time" | "mark_paid";

export type ActionDescriptor = {
  id: ActionId;
  label(order: Order): string;
  variant(order: Order): ActionVariant;
  visible(order: Order): boolean;
  enabled(order: Order): boolean;
  invoke(ctx: ActionContext): Promise<void>;
};

export const ACTION_REGISTRY: Record<ActionId, ActionDescriptor> = {
  send_to_customer: {
    id: "send_to_customer",
    label: () => "Send to customer",
    variant: () => "primary",
    // On draft, hide once chat flow has attached scheduling — at that point
    // the operator wants "Approve & confirm" (confirm_tentative_booking), not
    // a generic send. leadAction() then falls through to the tentative path.
    visible: (o) => !(o.scheduledAt != null && o.providerId != null && o.status === "draft"),
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("estimated"),
  },
  confirm_tentative_booking: {
    id: "confirm_tentative_booking",
    label: () => "Approve & confirm",
    variant: () => "primary",
    // Only show when the chat flow has already attached a slot + mechanic.
    visible: (o) => o.scheduledAt != null && o.providerId != null,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("scheduled"),
  },
  confirm_booking: {
    id: "confirm_booking",
    label: () => "Confirm booking",
    variant: () => "primary",
    visible: (o) => o.scheduledAt != null && o.providerId != null,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("scheduled"),
  },
  reject_booking: {
    id: "reject_booking",
    label: () => "Reject booking",
    variant: () => "danger",
    visible: () => true,
    enabled: () => true,
    invoke: async (ctx) => {
      const reason = await ctx.askReason({ title: "Reject booking" });
      if (reason === null) return;
      await ctx.transitionStatus("cancelled", reason || undefined);
    },
  },
  reschedule: {
    id: "reschedule",
    label: (o) => o.scheduledAt ? "Reschedule" : "Set appointment time",
    variant: () => "secondary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => {
      ctx.openDialog("set_time");
      return Promise.resolve();
    },
  },
  set_time: {
    id: "set_time",
    label: () => "Set appointment time",
    variant: () => "secondary",
    visible: (o) => o.scheduledAt == null,
    enabled: () => true,
    invoke: (ctx) => {
      ctx.openDialog("set_time");
      return Promise.resolve();
    },
  },
  reassign_mechanic: {
    id: "reassign_mechanic",
    label: (o) => o.providerId != null ? "Reassign mechanic" : "Assign mechanic",
    variant: () => "secondary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => {
      ctx.openDialog("reassign");
      return Promise.resolve();
    },
  },
  approve_estimate: {
    /* admin override: estimated → approved */ id: "approve_estimate",
    label: () => "Approve",
    variant: () => "secondary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("approved"),
  },
  decline_estimate: {
    /* admin override: estimated → declined */ id: "decline_estimate",
    label: () => "Decline",
    variant: () => "danger",
    visible: () => true,
    enabled: () => true,
    invoke: async (ctx) => {
      const r = await ctx.askReason({ title: "Decline estimate" });
      if (r === null) return;
      await ctx.transitionStatus("declined", r || undefined);
    },
  },
  revise_estimate: {
    /* declined → revised */ id: "revise_estimate",
    label: () => "Revise",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("revised"),
  },
  start_job: {
    /* scheduled → in_progress */ id: "start_job",
    label: () => "Start",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("in_progress"),
  },
  complete_job: {
    /* in_progress → completed */ id: "complete_job",
    label: () => "Complete",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("completed"),
  },
  cancel_order: {
    /* any non-terminal → cancelled */ id: "cancel_order",
    label: () => "Cancel",
    variant: (o) => o.status === "draft" ? "secondary" : "danger",
    visible: () => true,
    enabled: () => true,
    invoke: async (ctx) => {
      const r = await ctx.askReason({ title: "Cancel order" });
      if (r === null) return;
      await ctx.transitionStatus("cancelled", r || undefined);
    },
  },
  mark_paid: {
    id: "mark_paid",
    label: () => "Mark paid",
    variant: () => "primary",
    visible: (o) => o.paidAt == null,
    enabled: () => true,
    invoke: (ctx) => {
      ctx.openDialog("mark_paid");
      return Promise.resolve();
    },
    // The mark-paid dialog collects payment method + reference and calls
    // ctx.markPaid on submit. New component built in PR 4 (MarkPaidDialog).
  },
};
```

### Module boundary & dependencies

```
packages/shared/src/order/profiles.ts  ← pure TS; no React/HTTP
       ↑
       └── apps/hmls-web/lib/order-actions.ts  ← ACTION_REGISTRY, useActionInvoker
              ↑
              └── apps/hmls-web/components/order/
                    ├── OrderOpsPanel.tsx
                    ├── OrderDetailsCard.tsx
                    ├── OrderSectionsRegion.tsx
                    └── sections/{Items,Customer,Schedule,Notes}Section.tsx
                          ↑
                          └── apps/hmls-web/app/(admin)/admin/orders/[id]/page.tsx
```

`profiles.ts` does not import React, dialogs, or HTTP — staff agent can consume it later without
dragging in the web stack.

### Action invoker

```ts
function useActionInvoker(order: Order) {
  const { transitionStatus, setSchedule, markPaid, mutate } = useOrderMutations(order.id);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const askReason = useReasonDialog();

  const ctx: ActionContext = {
    order,
    transitionStatus,
    setSchedule,
    markPaid,
    mutate,
    openDialog: setDialog,
    askReason,
  };

  async function invoke(action: ActionDescriptor) {
    try {
      await action.invoke(ctx);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  }

  return { invoke, dialog, closeDialog: () => setDialog(null) };
}
```

- Single error-catch point for all actions.
- `dialog` state private to invoker; `OrderOpsPanel` mounts `<DialogHost dialog={dialog} ... />` as
  a sibling, so dialogs are scoped to the panel.
- Busy state comes from `useOrderMutations.transitioning`; `ActionButton` consumes it to
  self-disable.

### Right column

`leadAction(order)` resolves "the one action that should sit in the prominent slot right now". Two
rules in order:

1. If `profile.primary` is set AND its action's `visible(order)` is true, use it.
2. Otherwise walk `profile.actions` in declared order and return the first visible action whose
   `variant(order) === "primary"`.

```ts
export function leadAction(order: Order): ActionDescriptor | undefined {
  const profile = STATUS_PROFILES[order.status];
  if (profile.primary) {
    const named = ACTION_REGISTRY[profile.primary];
    if (named.visible(order)) return named;
  }
  for (const id of profile.actions) {
    const a = ACTION_REGISTRY[id];
    if (a.visible(order) && a.variant(order) === "primary") return a;
  }
  return undefined;
}
```

This gives the draft+tentative case the right answer: `profile.primary` is `send_to_customer`, but
`send_to_customer.visible(order)` returns false once scheduling is attached, so the walk falls
through to `confirm_tentative_booking`.

```tsx
function OrderOpsPanel({ order }: { order: Order }) {
  const profile = STATUS_PROFILES[order.status];
  const { invoke, dialog, closeDialog } = useActionInvoker(order);

  const visible = profile.actions
    .map((id) => ACTION_REGISTRY[id])
    .filter((a) => a.visible(order));

  const primary = leadAction(order);
  const secondary = visible.filter((a) => a !== primary && a.variant(order) === "secondary");
  const danger = visible.filter((a) => a !== primary && a.variant(order) === "danger");

  return (
    <>
      <Card>
        {primary && <ActionButton action={primary} order={order} onClick={invoke} prominent />}
        {secondary.map((a) => (
          <ActionButton
            key={a.id}
            action={a}
            order={order}
            onClick={invoke}
          />
        ))}
        {danger.map((a) => (
          <ActionButton key={a.id} action={a} order={order} onClick={invoke} variant="danger" />
        ))}
      </Card>
      <DialogHost order={order} dialog={dialog} onClose={closeDialog} />
    </>
  );
}
```

The page renders `<OrderOpsPanel /> + <OrderDetailsCard /> + <ActivityTimeline />` in the aside — no
other conditional panel switching.

### Main column

```tsx
function OrderSectionsRegion({ order }: { order: Order }) {
  const profile = STATUS_PROFILES[order.status];
  const can = (s: EditableSection) => profile.editableSections.includes(s);
  return (
    <>
      <ItemsSection order={order} readOnly={!can("items")} />
      <CustomerSection order={order} readOnly={!can("customer")} />
      <ScheduleSection order={order} readOnly={!can("schedule")} />
      <NotesSection order={order} readOnly={!can("notes")} />
    </>
  );
}
```

Each section follows the same contract:

```ts
type SectionProps = { order: Order; readOnly: boolean };
// Section owns useState<"view" | "edit">.
// When readOnly, the "Edit" affordance is hidden; section renders in view mode only.
// When the section has nothing to render for this order, it returns null (e.g., no notes yet).
```

Section save path goes through `useOrderMutations.saveItems` / `saveCustomer` / `setSchedule`. Save
errors are caught inside the section and shown inline + toast — section save is **not** routed
through `useActionInvoker` because editing is a different concept from action invocation.

### Banner

`DraftBanner` keeps the amber explanatory text but its button reuses
`<ActionButton action={leadAction(order)} prominent banner />` — the same `leadAction` defined
above. Same descriptor in two places, different visual treatment via a `banner` prop on
`ActionButton`.

The page no longer carries `tentative` state — `confirm_tentative_booking.visible(order)` is
`order.scheduledAt != null && order.providerId != null` and is the source of truth.

### Final page shape

```tsx
export default function OrderDetailPage() {
  const { data, isLoading, error } = useAdminOrder(id);
  if (isLoading) return <Skeleton />;
  if (error || !data) return <ErrorState />;
  const { order, events } = data;

  return (
    <PageShell>
      <Header order={order} />
      {order.status === "draft" && <DraftBanner order={order} />}
      <OrderProgressBar status={order.status} />
      <Layout>
        <main>
          <OrderSectionsRegion order={order} />
        </main>
        <aside>
          <OrderOpsPanel order={order} />
          <OrderDetailsCard order={order} />
          <ActivityTimeline events={events} />
        </aside>
      </Layout>
    </PageShell>
  );
}
```

Estimated line count: 1213 → ~350.

## Data flow

```
useAdminOrder(id)  ──SWR──►  { order, events }
       │
       ▼
all sections / panel / banner derive from the same order
       │
       ▼
status change → STATUS_PROFILES[newStatus] → new actions/sections
```

All mutations go through `useOrderMutations(id)`:

| Method                            | Endpoint                      | Used by                                             |
| --------------------------------- | ----------------------------- | --------------------------------------------------- |
| `transitionStatus(next, reason?)` | `POST /orders/:id/transition` | every transition action                             |
| `saveItems(items, notes)`         | `PATCH /orders/:id/items`     | ItemsSection                                        |
| `saveCustomer(patch)`             | `PATCH /orders/:id/contact`   | CustomerSection                                     |
| `setSchedule(at, providerId)`     | `PATCH /orders/:id/schedule`  | ScheduleSection, reschedule action, reassign action |
| `markPaid(method, ref?)`          | `POST /orders/:id/payment`    | mark_paid action                                    |

Each mutation calls `await mutate()` internally after success, so SWR refreshes and the whole
subtree re-renders.

**Hook changes needed**: `useOrderMutations` currently has `transitionStatus`, `saveItems`,
`saveCustomer`. We add `setSchedule` and `markPaid` (which today live in `SetTimeDialog` /
`ReassignBookingDialog` / a one-off in `[id]/page.tsx`).

After this change, `useOrderMutations` becomes the single client-side entry for all writes to an
order — symmetric to `common/tools/order.ts::create_order` on the server.

## Error handling

| Failure source         | Caught at                       | User feedback                  |
| ---------------------- | ------------------------------- | ------------------------------ |
| Action `invoke` throws | `useActionInvoker.invoke`       | `toast.error(message)`         |
| Section save throws    | Section's own try/catch         | inline error + `toast.error`   |
| SWR fetch error        | page top-level `<ErrorState />` | "Failed to load order" + retry |

Success is silent by default; an action's `invoke` can opt in to `toast.success(...)` when explicit
confirmation matters (e.g., `mark_paid`).

## What we delete

PR 3:

- `BookingPanel` component and its props plumbing
- `bookingBusy` state, `handleBookingConfirm`, `handleBookingReject`
- `reassignOpen` / `setTimeOpen` useState in `[id]/page.tsx`
- Generic `Actions` Card block (lines ~1108-1138)
- "Approve & confirm" / "Send to customer" inline buttons in the banner

PR 4:

- `editMode` useState + `handleSaveItems` / `handleSaveCustomer` in `[id]/page.tsx`
- `SHOW_ESTIMATE_PANEL_STATUSES` / `SHOW_QUOTE_PANEL_STATUSES` / `SHOW_BOOKING_PANEL_STATUSES`
  constants
- `TRANSITION_LABELS` map (labels now live on `ActionDescriptor`)
- `DANGER_ACTIONS` set
- `components/order/ItemEditor.tsx`, `components/order/CustomerEditor.tsx` (replaced by sections)

## Migration sequence

Each PR is independently shippable and the app builds + works at every stage.

**PR 1 — Description layer (no UI change)**

- New `packages/shared/src/order/profiles.ts` (types + `STATUS_PROFILES`)
- Re-export from `packages/shared/src/order/index.ts`
- Unit tests: every `OrderStatus` has a profile; profile references valid `ActionId` /
  `EditableSection`; `primary` if set is in `actions`
- No web code touched

**PR 2 — Action layer (still no UI)**

- New `apps/hmls-web/lib/order-actions.ts`: `ACTION_REGISTRY`, `ActionContext`, `useActionInvoker`
- Extend `useOrderMutations` with `setSchedule`, `markPaid`
- Unit tests per `ActionDescriptor`: `visible` / `enabled` boundary cases; `invoke` calls the right
  ctx method with the right arguments (mock ctx)
- No page changes

**PR 3 — Right column replacement**

- New `OrderOpsPanel`, `OrderDetailsCard`, `DialogHost`, `ActionButton`
- `[id]/page.tsx` aside: replace `<BookingPanel>` + Actions Card + banner buttons
- Visual parity check: screenshot every status before/after
- Delete the items listed under "What we delete → PR 3"

**PR 4 — Main column replacement**

- New `OrderSectionsRegion` + 4 section components (`ItemsSection`, `CustomerSection`,
  `ScheduleSection`, `NotesSection`)
- New `MarkPaidDialog` (small form: payment method + reference; calls `ctx.markPaid`)
- `ScheduleSection` is a genuinely new component — see Risks
- `[id]/page.tsx` main: replace with `<OrderSectionsRegion />`
- Delete the items listed under "What we delete → PR 4"
- Final page should land near 350 lines

## Testing

| Layer                                                                                     | Method                                                                   | PR             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------- |
| `STATUS_PROFILES` completeness                                                            | Vitest unit                                                              | PR 1           |
| Each `ActionDescriptor` (`visible`, `enabled`, `invoke`)                                  | Vitest unit with mock ctx                                                | PR 2           |
| `useActionInvoker` error catch                                                            | Vitest unit; assert `toast.error` called, error not rethrown             | PR 2           |
| `OrderOpsPanel` grouping (primary / secondary / danger)                                   | RTL render with sample orders per status; assert button labels and order | PR 3           |
| Section `readOnly` toggle                                                                 | RTL; given each status, assert "Edit" button presence                    | PR 4           |
| End-to-end happy path: draft → estimated → approved → scheduled → in_progress → completed | Playwright                                                               | PR 4 close-out |

`bun run typecheck && bun run lint && bun run build` and `deno task check` must pass on every PR.

## Risks & mitigations

1. **`ScheduleSection` is genuinely new design**, not a transplant. Current `BookingPanel` shows
   `2016 Ford F-150 / Mon May 25 10:00 / Spencer Zhao` with inline action buttons. Need a section
   equivalent that supports view + edit (date/time picker, mechanic picker) inline. Mitigation:
   build a first cut, screenshot it, get explicit sign-off before PR 4 lands.

2. **`visible(order)` must reproduce existing implicit booleans**. Today's `BookingPanel` uses
   `needsDispatch`, `isUnscheduled`, `canConfirm`. `canConfirm` in particular is
   `scheduledAt != null && providerId != null && order.status !== "scheduled"`. Each existing
   boolean must be transcribed into the corresponding `ActionDescriptor.visible`. Mitigation: PR 2
   reviewer should diff old booleans against new `visible` impls line-by-line; unit tests cover
   boundary cases.

3. **Banner uses same action with different visual styling**. `ActionButton` needs a `banner` prop
   that swaps to amber background. Mitigation: dedicated RTL test renders the same action in both
   contexts and asserts class differences.

4. **`packages/shared` change must pass Deno check**. `profiles.ts` is pure TS with no runtime deps;
   should be fine. Mitigation: PR 1 CI runs `deno task check`.

5. **Staff agent / customer portal coupling** — currently not in scope, but `profiles.ts` is a
   shared module. If anything imports from it later, breaking changes propagate. Mitigation: keep
   the type exports stable; document that `STATUS_PROFILES` is consumer-facing.

## Open questions

None at this time. All design decisions captured during brainstorming have been incorporated:

- `label` / `variant` / `enabled` are functions of `order` (not static strings).
- `EditableSection` and `Action` are independent concepts in `StatusProfile`.
- `OrderSectionsRegion` is built in the same migration as `OrderOpsPanel` (no intermediate state
  with mixed paradigms).
- `ScheduleSection` is inline-editable; dialogs are a fallback path.
- `DialogHost` is mounted inside `OrderOpsPanel`, not at page top level.

## Out of scope (future)

- Staff agent reading `STATUS_PROFILES` to answer "what can I do on this order".
- Customer-side portal pages adopting the same model — current scope is admin only.
- Status-machine UI generator extending to non-order entities (customers, mechanics) — same pattern
  would apply, but those pages aren't redundancy hotspots today.
