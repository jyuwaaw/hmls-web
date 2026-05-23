# Order detail — status-driven UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the admin order detail page's three parallel UI paths (`BookingPanel`, `Actions`
Card, draft banner) into a single status-driven action model. Each `OrderStatus` declaratively names
its candidate actions + editable sections; the page becomes a renderer over two registries.

**Architecture:** Two-tier model. `packages/shared/src/order/profiles.ts` holds the pure-data
`STATUS_PROFILES` (React-free, importable by gateway and agent).
`apps/hmls-web/lib/order-actions.ts` holds `ACTION_REGISTRY` + `useActionInvoker` + `leadAction` (UI
tier; touches dialogs, toast, SWR). Components are pure renderers over these two registries.

**Tech Stack:** Deno workspace, TypeScript strict mode, Drizzle types via `@hmls/shared/db/types`,
Next.js 16 App Router, React 19, Tailwind 4, shadcn, SWR, sonner, `bun:test` (web) + `deno test`
(shared).

**Spec:**
[docs/superpowers/specs/2026-05-22-order-detail-status-driven-ui-design.md](docs/superpowers/specs/2026-05-22-order-detail-status-driven-ui-design.md)

**Migration is 4 independent PRs.** Each PR leaves
`bun run typecheck && bun run lint && bun run
build && deno task check` green and the app shippable.
Tests in this plan target pure logic (profiles, action descriptors, leadAction); component-level RTL
tests are out of scope (no React testing library is installed today — would require a separate setup
PR).

---

## Phase 0 — Setup

### Task 0.1: Branch + worktree

**Files:** none (git only)

- [ ] **Step 1: Confirm starting branch is clean and up to date**

```bash
git fetch origin
git status
```

Expected: working tree clean (modulo untracked items the user already had — `.claude/commands/` and
a `CLAUDE.md` edit are OK to carry).

- [ ] **Step 2: Create feature branch off the current `pr-59` tip**

```bash
git checkout -b feat/order-detail-status-driven-ui
```

Expected: switched to a new branch.

---

## Phase 1 — Description layer (PR 1)

Adds `STATUS_PROFILES` to `@hmls/shared`. No web changes; no UI difference. PR 1 is the foundation
other PRs build on.

### Task 1.1: Create profiles.ts with types and full STATUS_PROFILES table

**Files:**

- Create: `packages/shared/src/order/profiles.ts`

- [ ] **Step 1: Write the file**

```ts
// packages/shared/src/order/profiles.ts
import type { OrderStatus } from "./status.ts";

/** Sections of the order detail main column that can be in "edit" mode at a
 *  given status. Independent of {@link ActionId}: an editable section is an
 *  affordance on the page, not a button. */
export type EditableSection = "items" | "customer" | "schedule" | "notes";

/** Every action the admin can take on an order. Names match the human-visible
 *  intent ("send_to_customer") rather than the target status, because some
 *  actions don't change status (mark_paid, reassign_mechanic, reschedule). */
export type ActionId =
  | "send_to_customer" // draft|revised → estimated
  | "approve_estimate" // estimated → approved (admin override of customer)
  | "decline_estimate" // estimated → declined (admin override)
  | "revise_estimate" // declined → revised
  | "confirm_tentative_booking" // draft → scheduled (chat-flow shortcut)
  | "confirm_booking" // approved → scheduled
  | "reject_booking" // approved → cancelled (with reason)
  | "reassign_mechanic" // dialog → PATCH /orders/:id/schedule
  | "reschedule" // dialog → PATCH /orders/:id/schedule
  | "set_time" // dialog → PATCH /orders/:id/schedule (when scheduledAt is null)
  | "start_job" // scheduled → in_progress
  | "complete_job" // in_progress → completed
  | "cancel_order" // any non-terminal → cancelled
  | "mark_paid"; // non-transition; POST /orders/:id/payment

export type StatusProfile = {
  status: OrderStatus;
  /** Candidates. Final visibility decided by `ActionDescriptor.visible(order)`. */
  actions: readonly ActionId[];
  /** Hint for banner button + panel-prominence slot. Resolved via leadAction(). */
  primary?: ActionId;
  editableSections: readonly EditableSection[];
};

export const STATUS_PROFILES: Readonly<Record<OrderStatus, StatusProfile>> = {
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
    // No primary: admin is usually waiting on the customer (portal approval).
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
    actions: [
      "set_time",
      "reassign_mechanic",
      "confirm_booking",
      "reject_booking",
    ],
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
  cancelled: {
    status: "cancelled",
    actions: [],
    editableSections: [],
  },
};
```

- [ ] **Step 2: Add export to deno.json**

Modify `packages/shared/deno.json` `exports` block; add the new entry after `./order/status`:

```json
"./order/profiles": "./src/order/profiles.ts",
```

- [ ] **Step 3: Type-check the package**

```bash
deno check packages/shared/src/order/profiles.ts
```

Expected: PASS (no diagnostics).

### Task 1.2: Unit tests for STATUS_PROFILES completeness

**Files:**

- Create: `packages/shared/src/order/profiles_test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/order/profiles_test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import type { OrderStatus } from "./status.ts";
import { TRANSITIONS } from "./status.ts";
import type { ActionId, EditableSection } from "./profiles.ts";
import { STATUS_PROFILES } from "./profiles.ts";

const VALID_ACTION_IDS = new Set<ActionId>([
  "send_to_customer",
  "approve_estimate",
  "decline_estimate",
  "revise_estimate",
  "confirm_tentative_booking",
  "confirm_booking",
  "reject_booking",
  "reassign_mechanic",
  "reschedule",
  "set_time",
  "start_job",
  "complete_job",
  "cancel_order",
  "mark_paid",
]);

const VALID_SECTIONS = new Set<EditableSection>([
  "items",
  "customer",
  "schedule",
  "notes",
]);

Deno.test("every OrderStatus has a profile", () => {
  for (const status of Object.keys(TRANSITIONS) as OrderStatus[]) {
    assert(STATUS_PROFILES[status], `missing profile for ${status}`);
    assertEquals(STATUS_PROFILES[status].status, status);
  }
});

Deno.test("profile.actions reference valid ActionIds", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    for (const id of profile.actions) {
      assert(VALID_ACTION_IDS.has(id), `${status}.actions has invalid ${id}`);
    }
  }
});

Deno.test("profile.primary, when set, must be in profile.actions", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    if (profile.primary == null) continue;
    assert(
      profile.actions.includes(profile.primary),
      `${status}.primary=${profile.primary} not in actions`,
    );
  }
});

Deno.test("profile.editableSections reference valid sections", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    for (const s of profile.editableSections) {
      assert(VALID_SECTIONS.has(s), `${status}.editableSections has invalid ${s}`);
    }
  }
});

Deno.test("terminal statuses have no actions", () => {
  assertEquals(STATUS_PROFILES.cancelled.actions.length, 0);
  // completed intentionally allows mark_paid (non-transition action).
});
```

- [ ] **Step 2: Run tests and verify they pass**

```bash
deno test packages/shared/src/order/profiles_test.ts
```

Expected: 5 tests pass.

### Task 1.3: Ship PR 1

- [ ] **Step 1: Run full CI locally**

```bash
deno task check
deno task lint
deno task fmt:check
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build
```

Expected: all green.

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/order/profiles.ts \
        packages/shared/src/order/profiles_test.ts \
        packages/shared/deno.json
git commit -m "feat(shared): order STATUS_PROFILES + ActionId + EditableSection

Pure-data registry of admin-side order actions and editable sections per
status. No consumer wired yet — web tier picks this up in the next PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Action layer (PR 2)

Adds `ACTION_REGISTRY` + `useActionInvoker` + `leadAction` to the web app. Extends
`useOrderMutations` with `markPaid`. No page changes; tests cover every action's logic.

### Task 2.1: Extend useOrderMutations with markPaid

**Files:**

- Modify: `apps/hmls-web/lib/api-paths.ts` (add `orderPayment`)
- Modify: `apps/hmls-web/hooks/useOrderMutations.ts`

- [ ] **Step 1: Add the payment path to `adminPaths`**

In `apps/hmls-web/lib/api-paths.ts`, after the `orderSchedule` entry inside the `adminPaths` object:

```ts
orderPayment: (id: number | string) => `/api/admin/orders/${id}/payment`,
```

- [ ] **Step 2: Add `markPaid` to useOrderMutations**

In `apps/hmls-web/hooks/useOrderMutations.ts`, add `savingPayment` state + `markPaid` function
modeled after `setSchedule`, and include them in the return value.

Insert after the `savingSchedule` state declaration:

```ts
const [savingPayment, setSavingPayment] = useState(false);
```

Insert after the `setSchedule` function:

```ts
async function markPaid(args: {
  amountCents: number;
  method: string;
  reference?: string;
  paidAt?: string;
}): Promise<void> {
  setSavingPayment(true);
  try {
    await api.post<Order>(adminPaths.orderPayment(id), args);
    revalidate();
  } catch (e) {
    toast.error(
      e instanceof Error ? e.message : "Failed to record payment",
    );
    throw e;
  } finally {
    setSavingPayment(false);
  }
}
```

Update the returned object to include `markPaid` and `savingPayment`:

```ts
return {
  transitionStatus,
  saveItems,
  saveCustomer,
  setSchedule,
  markPaid,
  transitioning,
  savingItems,
  savingCustomer,
  savingSchedule,
  savingPayment,
};
```

- [ ] **Step 3: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 2.2: Create order-actions.ts skeleton (types + ActionContext)

**Files:**

- Create: `apps/hmls-web/lib/order-actions.ts`

- [ ] **Step 1: Write the skeleton**

```ts
// apps/hmls-web/lib/order-actions.ts
import type { Order } from "@hmls/shared/db/types";
import type { OrderStatus } from "@hmls/shared/order/status";
import type { ActionId } from "@hmls/shared/order/profiles";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";

export type ActionVariant = "primary" | "secondary" | "danger";

export type DialogId = "reassign" | "set_time" | "mark_paid";

export type ActionContext = {
  order: Order;
  transitionStatus(next: OrderStatus, reason?: string): Promise<void>;
  setSchedule(
    scheduledAt: string,
    durationMinutes: number,
    location?: string | null,
  ): Promise<void>;
  markPaid(args: {
    amountCents: number;
    method: string;
    reference?: string;
    paidAt?: string;
  }): Promise<void>;
  openDialog(id: DialogId): void;
  askReason(opts: {
    title: string;
    description?: string;
  }): Promise<string | null>;
  mutate(): Promise<void> | void;
};

export type ActionDescriptor = {
  id: ActionId;
  label(order: Order): string;
  variant(order: Order): ActionVariant;
  visible(order: Order): boolean;
  enabled(order: Order): boolean;
  invoke(ctx: ActionContext): Promise<void>;
};

export const ACTION_REGISTRY: Readonly<Record<ActionId, ActionDescriptor>> = {} as never;
// Real entries land in Task 2.3.

export function leadAction(order: Order): ActionDescriptor | undefined {
  const profile = STATUS_PROFILES[order.status];
  if (profile.primary) {
    const named = ACTION_REGISTRY[profile.primary];
    if (named && named.visible(order)) return named;
  }
  for (const id of profile.actions) {
    const a = ACTION_REGISTRY[id];
    if (a && a.visible(order) && a.variant(order) === "primary") return a;
  }
  return undefined;
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 2.3: Populate ACTION_REGISTRY with all 14 descriptors

**Files:**

- Modify: `apps/hmls-web/lib/order-actions.ts`

- [ ] **Step 1: Replace the empty `ACTION_REGISTRY` stub with the full table**

Replace the `export const ACTION_REGISTRY: ... = {} as never;` line with:

```ts
export const ACTION_REGISTRY: Readonly<Record<ActionId, ActionDescriptor>> = {
  send_to_customer: {
    id: "send_to_customer",
    label: () => "Send to customer",
    variant: () => "primary",
    visible: (o) => !(o.scheduledAt != null && o.providerId != null && o.status === "draft"),
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("estimated"),
  },
  approve_estimate: {
    id: "approve_estimate",
    label: () => "Approve",
    variant: () => "secondary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("approved"),
  },
  decline_estimate: {
    id: "decline_estimate",
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
    id: "revise_estimate",
    label: () => "Revise",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("revised"),
  },
  confirm_tentative_booking: {
    id: "confirm_tentative_booking",
    label: () => "Approve & confirm",
    variant: () => "primary",
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
      const r = await ctx.askReason({ title: "Reject booking" });
      if (r === null) return;
      await ctx.transitionStatus("cancelled", r || undefined);
    },
  },
  reassign_mechanic: {
    id: "reassign_mechanic",
    label: (o) => (o.providerId != null ? "Reassign mechanic" : "Assign mechanic"),
    variant: () => "secondary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => {
      ctx.openDialog("reassign");
      return Promise.resolve();
    },
  },
  reschedule: {
    id: "reschedule",
    label: (o) => (o.scheduledAt ? "Reschedule" : "Set appointment time"),
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
  start_job: {
    id: "start_job",
    label: () => "Start",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("in_progress"),
  },
  complete_job: {
    id: "complete_job",
    label: () => "Complete",
    variant: () => "primary",
    visible: () => true,
    enabled: () => true,
    invoke: (ctx) => ctx.transitionStatus("completed"),
  },
  cancel_order: {
    id: "cancel_order",
    label: () => "Cancel",
    variant: (o) => (o.status === "draft" ? "secondary" : "danger"),
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
  },
};
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 2.4: Tests for ACTION_REGISTRY + leadAction

**Files:**

- Create: `apps/hmls-web/lib/order-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/hmls-web/lib/order-actions.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { Order } from "@hmls/shared/db/types";
import type { OrderStatus } from "@hmls/shared/order/status";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";
import { ACTION_REGISTRY, type ActionContext, leadAction } from "./order-actions";

function makeOrder(overrides: Partial<Order> = {}): Order {
  const base = {
    id: 1,
    status: "draft" as OrderStatus,
    scheduledAt: null,
    providerId: null,
    paidAt: null,
  };
  // Narrow type cast — tests only exercise the fields above. Add fields here
  // if a new ActionDescriptor reads them.
  return { ...base, ...overrides } as unknown as Order;
}

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    order: makeOrder(),
    transitionStatus: mock(async () => {}),
    setSchedule: mock(async () => {}),
    markPaid: mock(async () => {}),
    openDialog: mock(() => {}),
    askReason: mock(async () => "reason"),
    mutate: mock(() => {}),
    ...overrides,
  };
}

describe("ACTION_REGISTRY", () => {
  test("send_to_customer is hidden on draft+tentative", () => {
    const o = makeOrder({
      status: "draft",
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    expect(ACTION_REGISTRY.send_to_customer.visible(o)).toBe(false);
  });

  test("send_to_customer is visible on plain draft", () => {
    const o = makeOrder({ status: "draft", scheduledAt: null, providerId: null });
    expect(ACTION_REGISTRY.send_to_customer.visible(o)).toBe(true);
  });

  test("confirm_tentative_booking requires scheduledAt + providerId", () => {
    const partial = makeOrder({ scheduledAt: "2026-05-25T10:00:00Z", providerId: null });
    expect(ACTION_REGISTRY.confirm_tentative_booking.visible(partial)).toBe(false);

    const full = makeOrder({ scheduledAt: "2026-05-25T10:00:00Z", providerId: 7 });
    expect(ACTION_REGISTRY.confirm_tentative_booking.visible(full)).toBe(true);
  });

  test("mark_paid hides once paidAt is set", () => {
    const unpaid = makeOrder({ paidAt: null });
    expect(ACTION_REGISTRY.mark_paid.visible(unpaid)).toBe(true);
    const paid = makeOrder({ paidAt: "2026-05-26T12:00:00Z" });
    expect(ACTION_REGISTRY.mark_paid.visible(paid)).toBe(false);
  });

  test("cancel_order variant flips by status", () => {
    expect(ACTION_REGISTRY.cancel_order.variant(makeOrder({ status: "draft" }))).toBe("secondary");
    expect(ACTION_REGISTRY.cancel_order.variant(makeOrder({ status: "scheduled" }))).toBe("danger");
  });

  test("reassign_mechanic label flips by providerId", () => {
    expect(ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: null }))).toBe(
      "Assign mechanic",
    );
    expect(ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: 7 }))).toBe(
      "Reassign mechanic",
    );
  });

  test("reschedule label flips by scheduledAt", () => {
    expect(ACTION_REGISTRY.reschedule.label(makeOrder({ scheduledAt: null }))).toBe(
      "Set appointment time",
    );
    expect(
      ACTION_REGISTRY.reschedule.label(makeOrder({ scheduledAt: "2026-05-25T10:00:00Z" })),
    ).toBe("Reschedule");
  });
});

describe("ACTION_REGISTRY.invoke behavior", () => {
  test("send_to_customer transitions to estimated", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.send_to_customer.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("estimated");
  });

  test("confirm_booking transitions to scheduled", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.confirm_booking.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("scheduled");
  });

  test("reject_booking asks for reason and cancels", async () => {
    const ctx = makeCtx({ askReason: mock(async () => "customer no-show") });
    await ACTION_REGISTRY.reject_booking.invoke(ctx);
    expect(ctx.askReason).toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith("cancelled", "customer no-show");
  });

  test("reject_booking does nothing if user cancels the reason dialog", async () => {
    const ctx = makeCtx({ askReason: mock(async () => null) });
    await ACTION_REGISTRY.reject_booking.invoke(ctx);
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });

  test("reassign_mechanic opens the reassign dialog", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.reassign_mechanic.invoke(ctx);
    expect(ctx.openDialog).toHaveBeenCalledWith("reassign");
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });

  test("mark_paid opens the mark_paid dialog", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.mark_paid.invoke(ctx);
    expect(ctx.openDialog).toHaveBeenCalledWith("mark_paid");
  });
});

describe("leadAction", () => {
  test("returns profile.primary when visible", () => {
    const o = makeOrder({ status: "scheduled", scheduledAt: "x", providerId: 1 });
    const lead = leadAction(o);
    expect(lead?.id).toBe(STATUS_PROFILES.scheduled.primary);
  });

  test("falls through to next primary-variant action when profile.primary is hidden", () => {
    // draft+tentative: profile.primary=send_to_customer hides, falls to confirm_tentative_booking
    const o = makeOrder({
      status: "draft",
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    const lead = leadAction(o);
    expect(lead?.id).toBe("confirm_tentative_booking");
  });

  test("returns undefined when no primary candidate is visible", () => {
    const o = makeOrder({ status: "cancelled" });
    expect(leadAction(o)).toBeUndefined();
  });

  test("returns undefined when profile has no primary and no primary-variant actions visible", () => {
    // estimated profile has no .primary; its actions are approve/decline/cancel
    // — none are variant "primary".
    const o = makeOrder({ status: "estimated" });
    expect(leadAction(o)).toBeUndefined();
  });
});
```

> **Note:** the `makeOrder` helper uses a narrow type cast because `Order` has many fields the tests
> don't exercise. Keep the cast confined to test files.

- [ ] **Step 2: Run tests**

```bash
cd apps/hmls-web && bun test lib/order-actions.test.ts
```

Expected: all tests pass.

### Task 2.5: Ship PR 2

- [ ] **Step 1: Run full CI**

```bash
deno task check
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build && bun test
```

Expected: all green.

- [ ] **Step 2: Commit**

```bash
git add apps/hmls-web/lib/order-actions.ts \
        apps/hmls-web/lib/order-actions.test.ts \
        apps/hmls-web/lib/api-paths.ts \
        apps/hmls-web/hooks/useOrderMutations.ts
git commit -m "feat(web): order ACTION_REGISTRY + useActionInvoker scaffolding

Introduces ACTION_REGISTRY (14 admin actions) and leadAction() resolver,
backed by STATUS_PROFILES. Extends useOrderMutations with markPaid. No
page wiring yet — PR 3 replaces the right column with these primitives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Right column replacement (PR 3)

Replaces `BookingPanel`, the generic `Actions` Card, and the banner button with a single
`OrderOpsPanel` that renders from the registry. Dialogs (`SetTimeDialog`, `ReassignBookingDialog`)
move under a panel-local `DialogHost`. `useActionInvoker` owns dialog state.

### Task 3.1: Create useActionInvoker hook

**Files:**

- Modify: `apps/hmls-web/lib/order-actions.ts`

- [ ] **Step 1: Append the `useActionInvoker` hook to `order-actions.ts`**

At the bottom of `apps/hmls-web/lib/order-actions.ts`, add:

```ts
// ---------------------------------------------------------------------------
// Hook — wires registry against the mutation hook + dialog + toast layers.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { toast } from "sonner";
import { useOrderMutations } from "@/hooks/useOrderMutations";

/** Reason-prompt is currently a Promise<string | null> abstraction in the
 *  page; PR 3 keeps the existing `useReasonDialog` hook the page already
 *  uses. Pass it in so order-actions.ts stays free of dialog-component
 *  imports. */
export type ReasonAsker = (opts: {
  title: string;
  description?: string;
}) => Promise<string | null>;

export type OrderInvoker = {
  invoke(action: ActionDescriptor): Promise<void>;
  dialog: DialogId | null;
  closeDialog(): void;
  transitioning: boolean;
};

export function useActionInvoker(
  order: Order,
  revalidate: () => void,
  askReason: ReasonAsker,
): OrderInvoker {
  const m = useOrderMutations(order.id, revalidate);
  const [dialog, setDialog] = useState<DialogId | null>(null);

  const ctx: ActionContext = {
    order,
    transitionStatus: m.transitionStatus,
    setSchedule: m.setSchedule,
    markPaid: m.markPaid,
    openDialog: setDialog,
    askReason,
    mutate: () => revalidate(),
  };

  async function invoke(action: ActionDescriptor) {
    try {
      await action.invoke(ctx);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  }

  return {
    invoke,
    dialog,
    closeDialog: () => setDialog(null),
    transitioning: m.transitioning ||
      m.savingSchedule ||
      m.savingPayment,
  };
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 3.2: Create ActionButton component

**Files:**

- Create: `apps/hmls-web/components/order/ActionButton.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/hmls-web/components/order/ActionButton.tsx
"use client";

import type { Order } from "@hmls/shared/db/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionDescriptor } from "@/lib/order-actions";

type Props = {
  action: ActionDescriptor;
  order: Order;
  onClick(action: ActionDescriptor): void;
  /** Render large/featured (banner button or panel primary slot). */
  prominent?: boolean;
  /** Banner styling — amber background for the draft-review banner. */
  banner?: boolean;
  disabled?: boolean;
};

export function ActionButton({
  action,
  order,
  onClick,
  prominent,
  banner,
  disabled,
}: Props) {
  const variant = action.variant(order);
  const label = action.label(order);
  const isEnabled = action.enabled(order) && !disabled;

  return (
    <Button
      variant={variant === "danger" ? "outline" : prominent ? "default" : "ghost"}
      size={prominent ? "sm" : "xs"}
      disabled={!isEnabled}
      onClick={() => onClick(action)}
      className={cn(
        "w-full justify-center",
        variant === "danger" &&
          "text-destructive border-destructive/30 hover:bg-destructive/10",
        banner && "bg-amber-600 hover:bg-amber-700 text-white",
      )}
    >
      {label}
    </Button>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 3.3: Create DialogHost (mounts existing SetTime + Reassign dialogs)

**Files:**

- Create: `apps/hmls-web/components/order/DialogHost.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/hmls-web/components/order/DialogHost.tsx
"use client";

import type { Order } from "@hmls/shared/db/types";
import { ReassignBookingDialog } from "@/components/admin/mechanics/ReassignBookingDialog";
import { SetTimeDialog } from "@/components/admin/orders/SetTimeDialog";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import type { DialogId } from "@/lib/order-actions";

type Props = {
  order: Order;
  dialog: DialogId | null;
  onClose(): void;
  /** Trigger SWR re-fetch after a dialog mutates the order. */
  revalidate(): void;
  /** Suggested duration in minutes for SetTimeDialog when scheduledAt is null. */
  suggestedDurationMinutes: number;
};

export function DialogHost({
  order,
  dialog,
  onClose,
  revalidate,
  suggestedDurationMinutes,
}: Props) {
  const { setSchedule, savingSchedule } = useOrderMutations(order.id, revalidate);

  return (
    <>
      <ReassignBookingDialog
        order={order}
        open={dialog === "reassign"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onAssigned={() => {
          revalidate();
          onClose();
        }}
      />
      {dialog === "set_time" && (
        <SetTimeDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          initialScheduledAt={order.scheduledAt ?? null}
          initialDurationMinutes={order.durationMinutes ?? null}
          suggestedDurationMinutes={suggestedDurationMinutes}
          initialLocation={order.location ?? null}
          saving={savingSchedule}
          onSave={async (scheduledAt, durationMinutes, location) => {
            await setSchedule(scheduledAt, durationMinutes, location);
            onClose();
          }}
        />
      )}
      {
        /* mark_paid is rendered by PR 4's MarkPaidDialog. Until then we ignore
          it — completed-status pages today simply do nothing. */
      }
    </>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS. (Imports for `ReassignBookingDialog`, `SetTimeDialog`, and `Order.durationMinutes` /
`Order.location` already exist; this just consumes them.)

### Task 3.4: Create OrderOpsPanel

**Files:**

- Create: `apps/hmls-web/components/order/OrderOpsPanel.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/hmls-web/components/order/OrderOpsPanel.tsx
"use client";

import type { Order } from "@hmls/shared/db/types";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  ACTION_REGISTRY,
  leadAction,
  type ReasonAsker,
  useActionInvoker,
} from "@/lib/order-actions";
import { ActionButton } from "./ActionButton";
import { DialogHost } from "./DialogHost";

type Props = {
  order: Order;
  revalidate(): void;
  askReason: ReasonAsker;
  suggestedDurationMinutes: number;
};

export function OrderOpsPanel({
  order,
  revalidate,
  askReason,
  suggestedDurationMinutes,
}: Props) {
  const profile = STATUS_PROFILES[order.status];
  const invoker = useActionInvoker(order, revalidate, askReason);

  const visible = profile.actions
    .map((id) => ACTION_REGISTRY[id])
    .filter((a) => a.visible(order));

  const primary = leadAction(order);
  const secondary = visible.filter(
    (a) => a !== primary && a.variant(order) === "secondary",
  );
  const danger = visible.filter(
    (a) => a !== primary && a.variant(order) === "danger",
  );

  // Nothing to show on terminal statuses with no actions.
  if (!primary && secondary.length === 0 && danger.length === 0) return null;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4">
          <CardTitle className="text-sm">Actions</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="flex flex-col gap-2">
            {primary && (
              <ActionButton
                action={primary}
                order={order}
                onClick={invoker.invoke}
                disabled={invoker.transitioning}
                prominent
              />
            )}
            {secondary.map((a) => (
              <ActionButton
                key={a.id}
                action={a}
                order={order}
                onClick={invoker.invoke}
                disabled={invoker.transitioning}
              />
            ))}
            {danger.length > 0 && <Separator className="my-1" />}
            {danger.map((a) => (
              <ActionButton
                key={a.id}
                action={a}
                order={order}
                onClick={invoker.invoke}
                disabled={invoker.transitioning}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <DialogHost
        order={order}
        dialog={invoker.dialog}
        onClose={invoker.closeDialog}
        revalidate={revalidate}
        suggestedDurationMinutes={suggestedDurationMinutes}
      />
    </>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 3.5: Create OrderDetailsCard

**Files:**

- Create: `apps/hmls-web/components/order/OrderDetailsCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/hmls-web/components/order/OrderDetailsCard.tsx
"use client";

import type { Order } from "@hmls/shared/db/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";

type Props = {
  order: Order;
  /** Mechanic display name, looked up by caller (mechanics list lives in the
   *  parent page). */
  mechanicName?: string | null;
};

export function OrderDetailsCard({ order, mechanicName }: Props) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Details</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Order ID</span>
            <span className="text-foreground font-mono">#{order.id}</span>
          </div>
          {order.providerId != null && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Mechanic</span>
              <span className="text-foreground">
                {mechanicName ?? `#${order.providerId}`}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Updated</span>
            <span className="text-foreground">
              <DateTime value={order.updatedAt} format="datetime" />
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

Notes:

- The inline "Reassign" button is intentionally dropped from this card. Reassign is now an action in
  `OrderOpsPanel` (via `reassign_mechanic`) so it only appears in one place.

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 3.6: Create DraftBanner using shared ActionButton

**Files:**

- Create: `apps/hmls-web/components/order/DraftBanner.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/hmls-web/components/order/DraftBanner.tsx
"use client";

import { AlertTriangle } from "lucide-react";
import type { Order } from "@hmls/shared/db/types";
import { Card, CardContent } from "@/components/ui/card";
import {
  ACTION_REGISTRY,
  leadAction,
  type ReasonAsker,
  useActionInvoker,
} from "@/lib/order-actions";
import { ActionButton } from "./ActionButton";

type Props = {
  order: Order;
  revalidate(): void;
  askReason: ReasonAsker;
};

export function DraftBanner({ order, revalidate, askReason }: Props) {
  const lead = leadAction(order);
  const invoker = useActionInvoker(order, revalidate, askReason);

  // Identify the tentative case so the explanatory text matches the action.
  const tentative = ACTION_REGISTRY.confirm_tentative_booking.visible(order);

  if (!lead) return null;

  return (
    <Card className="border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 gap-0 py-0">
      <CardContent className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              {tentative ? "Tentative booking — pending your confirmation" : "Pending shop review"}
            </p>
            <p className="text-amber-800 dark:text-amber-300/90 mt-0.5">
              {tentative
                ? "Customer accepted the AI-drafted estimate and a time slot in chat. Review line items and pricing, then confirm to lock in the appointment."
                : "AI drafted this estimate from the customer chat. Review line items and pricing, then send it to the customer."}
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <ActionButton
            action={lead}
            order={order}
            onClick={invoker.invoke}
            disabled={invoker.transitioning}
            prominent
            banner
          />
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 3.7: Wire OrderOpsPanel + DraftBanner into the page, remove BookingPanel and Actions Card

**Files:**

- Modify: `apps/hmls-web/app/(admin)/admin/orders/[id]/page.tsx`

This task replaces three regions of the page in one go. Each region is shown with the exact
before/after.

- [ ] **Step 1: Add imports**

Near the top of `[id]/page.tsx` (in the existing import block from `@/components/order/...`):

```ts
import { DraftBanner } from "@/components/order/DraftBanner";
import { OrderDetailsCard } from "@/components/order/OrderDetailsCard";
import { OrderOpsPanel } from "@/components/order/OrderOpsPanel";
```

- [ ] **Step 2: Replace the draft banner**

Find the existing draft banner block (the JSX that starts with `{order.status === "draft" && (` and
includes `Approve & confirm` / `Send to customer` buttons — around the area near
`handleBookingConfirm`).

Replace it with:

```tsx
{
  order.status === "draft" && (
    <DraftBanner order={order} revalidate={mutate} askReason={askReason} />
  );
}
```

> `askReason` is the existing function returned by `useReasonDialog()` in the page. If the page does
> not yet hold a single `askReason` reference at the top scope, hoist the existing dialog hook call
> so all three new components share one instance.

- [ ] **Step 3: Replace `BookingPanel` and `Actions` Card in the aside**

Find the existing `<aside>` content (the column that today contains: `BookingPanel`, the Actions
Card with the `allowed.map(...)` button list, and the Details Card with Reassign).

Replace the entire aside content with:

```tsx
<aside className="space-y-4">
  <OrderOpsPanel
    order={order}
    revalidate={mutate}
    askReason={askReason}
    suggestedDurationMinutes={suggestedDurationMinutes}
  />
  <OrderDetailsCard
    order={order}
    mechanicName={bookingProviderName}
  />
  <Card className="gap-0 py-0">
    <CardHeader className="px-4 py-4">
      <CardTitle className="text-sm">Activity</CardTitle>
    </CardHeader>
    <CardContent className="px-4 pb-4">
      <ActivityTimeline events={data.events ?? []} />
    </CardContent>
  </Card>
</aside>;
```

`suggestedDurationMinutes` is the same value the existing `<BookingPanel>` was reading (computed
from `order.items` via the existing helper in the page). Re-use the existing computation; do not
rename or move it in this PR.

- [ ] **Step 4: Delete the now-orphaned code in `[id]/page.tsx`**

Remove the following items inline. The exact line numbers will shift as edits land; rely on search:

- Delete the `BookingPanel` function declaration (the React component, ~lines 451-505 in the
  original).
- Delete the `bookingBusy` state + `handleBookingConfirm` + `handleBookingReject` helpers.
- Delete the `reassignOpen` + `setTimeOpen` `useState` declarations.
- Delete the standalone `<ReassignBookingDialog ... />` and `{setTimeOpen && <SetTimeDialog ... />}`
  blocks at the bottom of the JSX — they are now mounted inside `OrderOpsPanel` via `DialogHost`.

- [ ] **Step 5: Type-check, lint, build**

```bash
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build
```

Expected: all green. If lint complains about unused imports (`ReassignBookingDialog`,
`SetTimeDialog`, `Send`, `CheckCircle`, etc.), remove them.

### Task 3.8: Manual visual parity check

**Files:** none

- [ ] **Step 1: Start dev servers**

```bash
infisical run --env=dev -- deno task dev:api
```

In another terminal:

```bash
cd apps/hmls-web && GATEWAY_URL=http://localhost:8080 infisical run --env=dev -- bun run dev
```

- [ ] **Step 2: Walk through each status manually**

For each status below, open an order in that state in `/admin/orders/:id` and verify the right
column now shows a single "Actions" card matching the old behavior:

| Status                                           | Expected actions visible                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| draft (plain)                                    | Send to customer (primary), Reassign mechanic, Set/Reschedule, Cancel                |
| draft + tentative (scheduledAt + providerId set) | Approve & confirm (primary in banner + panel), Reassign mechanic, Reschedule, Cancel |
| estimated                                        | Approve, Decline, Cancel — no primary                                                |
| declined                                         | Revise (primary)                                                                     |
| revised                                          | Send to customer (primary), Cancel                                                   |
| approved                                         | Confirm booking (primary), Set time, Reassign mechanic, Reject booking               |
| scheduled                                        | Start (primary), Reschedule, Reassign mechanic, Cancel                               |
| in_progress                                      | Complete (primary), Cancel                                                           |
| completed                                        | Mark paid (primary, hides once paidAt set)                                           |
| cancelled                                        | No Actions card rendered                                                             |

If any case diverges from the table above, fix in the relevant `ActionDescriptor.visible` or in
`STATUS_PROFILES`. Document the change in the PR description.

### Task 3.9: Ship PR 3

- [ ] **Step 1: Run full CI**

```bash
deno task check
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build && bun test
```

Expected: all green.

- [ ] **Step 2: Commit**

```bash
git add -A
git status   # double-check no .env, secrets, or stray files
git commit -m "feat(admin-orders): collapse right column into status-driven OrderOpsPanel

Replaces BookingPanel + Actions Card + banner buttons with a single
OrderOpsPanel that renders from ACTION_REGISTRY filtered by
STATUS_PROFILES. DialogHost lives inside the panel; useActionInvoker
owns dialog state. Banner reuses the same ActionButton with a banner
prop for amber styling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Main column replacement (PR 4)

Replaces the inline `editMode` switch in the main column with four section components driven by
`STATUS_PROFILES.editableSections`. Builds the `MarkPaidDialog` and wires it into `DialogHost`.

### Task 4.1: Build the section contract — common types

**Files:**

- Create: `apps/hmls-web/components/order/sections/types.ts`

- [ ] **Step 1: Write the shared section types**

```ts
// apps/hmls-web/components/order/sections/types.ts
import type { Order } from "@hmls/shared/db/types";

export type SectionProps = {
  order: Order;
  readOnly: boolean;
  /** Triggers SWR re-fetch after the section mutates the order. */
  revalidate(): void;
};
```

### Task 4.2: ItemsSection (replaces inline ItemEditor)

**Files:**

- Create: `apps/hmls-web/components/order/sections/ItemsSection.tsx`
- Keep `apps/hmls-web/components/order/ItemEditor.tsx` for now — section delegates to it internally
  so this PR doesn't touch the editor's internals.

- [ ] **Step 1: Write the section**

```tsx
// apps/hmls-web/components/order/sections/ItemsSection.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ItemEditor } from "@/components/order/ItemEditor";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import { formatCurrency } from "@/lib/format";
import type { SectionProps } from "./types";

export function ItemsSection({ order, readOnly, revalidate }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const { saveItems, savingItems } = useOrderMutations(order.id, revalidate);

  if (editing && !readOnly) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <ItemEditor
            initialItems={order.items ?? []}
            initialNotes={order.notes ?? ""}
            saving={savingItems}
            onSave={async (items, notes) => {
              await saveItems(items, notes);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Line items</CardTitle>
        {!readOnly && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-1.5">
        {(order.items ?? []).map((it, i) => (
          <div key={i} className="flex justify-between">
            <span className="text-foreground">{it.title}</span>
            <span className="text-muted-foreground">
              {formatCurrency((it.priceCents ?? 0) * (it.quantity ?? 1))}
            </span>
          </div>
        ))}
        {(order.items ?? []).length === 0 && <p className="text-muted-foreground">No items yet.</p>}
      </CardContent>
    </Card>
  );
}
```

> If the existing `ItemEditor` exposes a different prop signature than the call above, adapt the
> names — but keep the contract `(items, notes) → Promise<void>`. Do not rename the editor in this
> PR.

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS. If `formatCurrency` doesn't exist, inline the formatter the page already uses
(search for `Intl.NumberFormat` in the codebase).

### Task 4.3: CustomerSection (replaces inline CustomerEditor)

**Files:**

- Create: `apps/hmls-web/components/order/sections/CustomerSection.tsx`

- [ ] **Step 1: Write the section**

```tsx
// apps/hmls-web/components/order/sections/CustomerSection.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerEditor } from "@/components/order/CustomerEditor";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import type { SectionProps } from "./types";

export function CustomerSection({ order, readOnly, revalidate }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const { saveCustomer, savingCustomer } = useOrderMutations(order.id, revalidate);

  if (editing && !readOnly) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Customer</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <CustomerEditor
            initialContact={{
              contact_name: order.contactName ?? "",
              contact_email: order.contactEmail ?? "",
              contact_phone: order.contactPhone ?? "",
              contact_address: order.contactAddress ?? "",
            }}
            saving={savingCustomer}
            onSave={async (patch) => {
              await saveCustomer(patch);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Customer</CardTitle>
        {!readOnly && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-1">
        <p className="text-foreground">{order.contactName ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactPhone ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactEmail ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactAddress ?? "—"}</p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 4.4: ScheduleSection (genuinely new component)

**Files:**

- Create: `apps/hmls-web/components/order/sections/ScheduleSection.tsx`

- [ ] **Step 1: Write the section — view mode delegates edit to the existing dialogs**

```tsx
// apps/hmls-web/components/order/sections/ScheduleSection.tsx
"use client";

import { Calendar, MapPin, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { useAdminMechanics } from "@/hooks/useAdminMechanics";
import type { SectionProps } from "./types";

type Props = SectionProps & {
  /** Open the set-time dialog from the parent (`OrderOpsPanel` mounts it). */
  onSetTime(): void;
  /** Open the reassign dialog from the parent. */
  onReassign(): void;
};

export function ScheduleSection({
  order,
  readOnly,
  onSetTime,
  onReassign,
}: Props) {
  const { mechanics } = useAdminMechanics();
  const mechanic = order.providerId != null
    ? mechanics.find((m) => m.id === order.providerId)
    : null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Appointment</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          {order.scheduledAt
            ? <DateTime value={order.scheduledAt} format="datetime" />
            : <span className="text-muted-foreground">No time set</span>}
        </div>
        <div className="flex items-center gap-2">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
          {mechanic?.name ?? <span className="text-muted-foreground">Unassigned</span>}
        </div>
        {order.location && (
          <div className="flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-foreground">{order.location}</span>
          </div>
        )}
        {!readOnly && (
          <div className="flex gap-2 pt-2">
            <Button variant="ghost" size="xs" onClick={onSetTime}>
              {order.scheduledAt ? "Reschedule" : "Set time"}
            </Button>
            <Button variant="ghost" size="xs" onClick={onReassign}>
              {order.providerId != null ? "Reassign" : "Assign mechanic"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

The "Edit" affordance lives as two buttons that reuse the same dialogs the actions panel already
mounts via `DialogHost`. The buttons forward to the same invoker — see Task 4.6 for how the parent
page wires `onSetTime` / `onReassign`.

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS. (`useAdminMechanics` already exists.)

### Task 4.5: NotesSection

**Files:**

- Create: `apps/hmls-web/components/order/sections/NotesSection.tsx`

- [ ] **Step 1: Write the section (read-only for this PR)**

```tsx
// apps/hmls-web/components/order/sections/NotesSection.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SectionProps } from "./types";

export function NotesSection({ order }: SectionProps) {
  if (!order.adminNotes && !order.notes) return null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Notes</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-2">
        {order.adminNotes && (
          <div>
            <p className="text-muted-foreground">Admin notes</p>
            <p className="text-foreground whitespace-pre-wrap">{order.adminNotes}</p>
          </div>
        )}
        {order.notes && (
          <div>
            <p className="text-muted-foreground">Estimate notes</p>
            <p className="text-foreground whitespace-pre-wrap">{order.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

> Notes editing is not in any `STATUS_PROFILES.editableSections` today (no status lists `"notes"`).
> The section is included for parity with the spec; if the user later wants editable notes, add it
> to the relevant profile and extend this component.

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 4.6: OrderSectionsRegion

**Files:**

- Create: `apps/hmls-web/components/order/OrderSectionsRegion.tsx`

- [ ] **Step 1: Write the region**

```tsx
// apps/hmls-web/components/order/OrderSectionsRegion.tsx
"use client";

import type { Order } from "@hmls/shared/db/types";
import { type EditableSection, STATUS_PROFILES } from "@hmls/shared/order/profiles";
import { CustomerSection } from "./sections/CustomerSection";
import { ItemsSection } from "./sections/ItemsSection";
import { NotesSection } from "./sections/NotesSection";
import { ScheduleSection } from "./sections/ScheduleSection";

type Props = {
  order: Order;
  revalidate(): void;
  /** Forwarded from the page so ScheduleSection can request the same dialogs
   *  OrderOpsPanel mounts. */
  onSetTime(): void;
  onReassign(): void;
};

export function OrderSectionsRegion({
  order,
  revalidate,
  onSetTime,
  onReassign,
}: Props) {
  const profile = STATUS_PROFILES[order.status];
  const can = (s: EditableSection) => profile.editableSections.includes(s);
  return (
    <div className="space-y-4">
      <ItemsSection order={order} readOnly={!can("items")} revalidate={revalidate} />
      <CustomerSection order={order} readOnly={!can("customer")} revalidate={revalidate} />
      <ScheduleSection
        order={order}
        readOnly={!can("schedule")}
        revalidate={revalidate}
        onSetTime={onSetTime}
        onReassign={onReassign}
      />
      <NotesSection order={order} readOnly={true} revalidate={revalidate} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 4.7: MarkPaidDialog

**Files:**

- Create: `apps/hmls-web/components/order/MarkPaidDialog.tsx`

- [ ] **Step 1: Write the dialog**

```tsx
// apps/hmls-web/components/order/MarkPaidDialog.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  defaultAmountCents: number;
  saving: boolean;
  onSubmit(args: {
    amountCents: number;
    method: string;
    reference?: string;
  }): Promise<void>;
};

const METHODS = ["cash", "card", "check", "transfer", "other"] as const;

export function MarkPaidDialog({
  open,
  onOpenChange,
  defaultAmountCents,
  saving,
  onSubmit,
}: Props) {
  const [amount, setAmount] = useState(
    (defaultAmountCents / 100).toFixed(2),
  );
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter a positive amount");
      return;
    }
    setError(null);
    await onSubmit({
      amountCents: cents,
      method,
      reference: reference.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label htmlFor="amount">Amount (USD)</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="method">Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="reference">Reference (optional)</Label>
            <Input
              id="reference"
              placeholder="check #, confirmation code, etc."
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS. If `Select` / `Label` / `Input` paths differ in this repo, adjust the imports —
these are shadcn primitives that already exist elsewhere.

### Task 4.8: Wire MarkPaidDialog into DialogHost

**Files:**

- Modify: `apps/hmls-web/components/order/DialogHost.tsx`

- [ ] **Step 1: Add MarkPaidDialog mount + markPaid call**

In `DialogHost.tsx`, replace the trailing comment

```tsx
{
  /* mark_paid is rendered by PR 4's MarkPaidDialog. Until then we ignore
          it — completed-status pages today simply do nothing. */
}
```

with:

```tsx
{
  dialog === "mark_paid" && (
    <MarkPaidDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      defaultAmountCents={order.subtotalCents ?? 0}
      saving={savingPayment}
      onSubmit={async (args) => {
        await markPaid(args);
        onClose();
      }}
    />
  );
}
```

Update the destructure at the top of `DialogHost`:

```tsx
const { setSchedule, savingSchedule, markPaid, savingPayment } = useOrderMutations(
  order.id,
  revalidate,
);
```

Add the import:

```tsx
import { MarkPaidDialog } from "./MarkPaidDialog";
```

- [ ] **Step 2: Type-check**

```bash
cd apps/hmls-web && bun run typecheck
```

Expected: PASS.

### Task 4.9: Replace the page main column with OrderSectionsRegion

**Files:**

- Modify: `apps/hmls-web/app/(admin)/admin/orders/[id]/page.tsx`

- [ ] **Step 1: Add imports**

```ts
import { OrderSectionsRegion } from "@/components/order/OrderSectionsRegion";
```

- [ ] **Step 2: Extend `useActionInvoker` to expose `openDialog`**

`OrderSectionsRegion`'s `ScheduleSection` needs to open the same dialogs `OrderOpsPanel` mounts.
Cleanest path: hoist the invoker to the page level so both consumers share one instance.

In `apps/hmls-web/lib/order-actions.ts`, update the `OrderInvoker` return type and value to expose
`openDialog`:

```ts
export type OrderInvoker = {
  invoke(action: ActionDescriptor): Promise<void>;
  dialog: DialogId | null;
  openDialog(id: DialogId): void;
  closeDialog(): void;
  transitioning: boolean;
};

// In useActionInvoker(...)
return {
  invoke,
  dialog,
  openDialog: setDialog,
  closeDialog: () => setDialog(null),
  transitioning: m.transitioning || m.savingSchedule || m.savingPayment,
};
```

- [ ] **Step 3: Change `OrderOpsPanel`'s prop signature to take a shared invoker**

In `apps/hmls-web/components/order/OrderOpsPanel.tsx`:

- Replace the prop type:
  ```tsx
  type Props = {
    order: Order;
    invoker: OrderInvoker;
    revalidate(): void;
    suggestedDurationMinutes: number;
  };
  ```
- Remove the internal `useActionInvoker(...)` call; use the passed `invoker` directly.
- Add `import type { OrderInvoker } from "@/lib/order-actions";` and drop the `ReasonAsker` /
  `useActionInvoker` imports.

- [ ] **Step 4: Hoist `useActionInvoker` in the page and add `OrderSectionsRegion`**

In `[id]/page.tsx`:

```tsx
import { useActionInvoker } from "@/lib/order-actions";
import { OrderSectionsRegion } from "@/components/order/OrderSectionsRegion";

// inside the component, after `const { askReason } = useReasonDialog();`
const invoker = useActionInvoker(order, mutate, askReason);
```

Replace the existing main-column JSX (the editMode region) with:

```tsx
<main>
  <OrderSectionsRegion
    order={order}
    revalidate={mutate}
    onSetTime={() => invoker.openDialog("set_time")}
    onReassign={() => invoker.openDialog("reassign")}
  />
</main>;
```

Update the `<OrderOpsPanel>` call site in the aside to pass the shared invoker:

```tsx
<OrderOpsPanel
  order={order}
  invoker={invoker}
  revalidate={mutate}
  suggestedDurationMinutes={suggestedDurationMinutes}
/>;
```

The visual contract is unchanged — only the hook lifecycle moves up one level so dialogs opened from
either side land in the same `DialogHost`.

- [ ] **Step 5: Delete the now-orphaned code in `[id]/page.tsx`**

- Delete the `editMode` `useState` declaration.
- Delete `handleSaveItems` / `handleSaveCustomer` (sections own their save calls now).
- Delete the JSX branches that read `editMode === "items"` / `editMode === "customer"`.
- Delete the `SHOW_ESTIMATE_PANEL_STATUSES` / `SHOW_QUOTE_PANEL_STATUSES` /
  `SHOW_BOOKING_PANEL_STATUSES` constants — no longer referenced.
- Delete the `TRANSITION_LABELS` map.
- Delete the `DANGER_ACTIONS` set.

**Do NOT delete** `apps/hmls-web/components/order/ItemEditor.tsx` or `CustomerEditor.tsx`. The new
`ItemsSection` / `CustomerSection` delegate to them in edit mode. Inlining their internals into the
sections is a mechanical follow-up (flagged under "Follow-ups" at the bottom of this plan) — out of
scope for this PR.

- [ ] **Step 6: Type-check, lint, build**

```bash
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build
```

Expected: all green. Final `[id]/page.tsx` should now be ~350-450 lines (vs 1213 before).

### Task 4.10: Manual main-column parity check

**Files:** none

- [ ] **Step 1: Start dev servers (as in Task 3.8)**

- [ ] **Step 2: Walk through editable status combinations**

For each status with editable sections, verify:

| Status                                         | Editable sections (per profile) |
| ---------------------------------------------- | ------------------------------- |
| draft                                          | items, customer, schedule       |
| estimated                                      | items, customer                 |
| revised                                        | items, customer                 |
| approved                                       | schedule                        |
| scheduled                                      | schedule                        |
| declined / in_progress / completed / cancelled | none                            |

In each editable status, click "Edit" on the listed sections, change a field, save, and confirm the
SWR refetch updates the view. In non-editable statuses, confirm no "Edit" button is rendered.

- [ ] **Step 3: Verify mark_paid**

On a completed order with `paidAt == null`:

- "Mark paid" is the primary action.
- Clicking it opens `MarkPaidDialog`.
- Submitting with a valid amount records the payment and the action disappears (since
  `paidAt != null` now).

### Task 4.11: Ship PR 4

- [ ] **Step 1: Run full CI**

```bash
deno task check
cd apps/hmls-web && bun run typecheck && bun run lint && bun run build && bun test
```

Expected: all green.

- [ ] **Step 2: Commit**

```bash
git add -A
git status
git commit -m "feat(admin-orders): main column becomes status-driven sections

Replaces the editMode switch in [id]/page.tsx with OrderSectionsRegion +
4 sections (Items, Customer, Schedule, Notes), each rendering view/edit
per STATUS_PROFILES.editableSections. Adds MarkPaidDialog for the
mark_paid action. Final page is ~350 lines (down from 1213).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Wrap-up

### Task 5.1: Open PR and link the spec

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/order-detail-status-driven-ui
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "Order detail — status-driven UI (4-PR landing as one)" --body "$(cat <<'EOF'
## Summary
- Collapse Appointment + Actions + draft banner into one OrderOpsPanel
- Profile-driven editable sections in the main column
- Final \`[id]/page.tsx\` ~350 lines (was 1213)

Spec: docs/superpowers/specs/2026-05-22-order-detail-status-driven-ui-design.md
Plan: docs/superpowers/plans/2026-05-22-order-detail-status-driven-ui.md

## Test plan
- [ ] \`deno task check\` + \`bun run typecheck && bun run lint && bun run build && bun test\`
- [ ] Manual parity check across all 9 OrderStatus values
- [ ] Mark-paid flow on a completed unpaid order

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

> If the team prefers landing the 4 PRs separately instead of as one feature branch, branch each
> phase off main and rebase. Each phase's commits are self-contained.

---

## Follow-ups (out of scope for this plan)

- Inline `ItemEditor` / `CustomerEditor` into their sections so the legacy components can be deleted
  (mechanical refactor; ~1 commit).
- React Testing Library setup (no current dependency) so `OrderOpsPanel` rendering can be
  unit-tested instead of relying on the manual parity check in Tasks 3.8 / 4.10.
- Staff agent consumes `STATUS_PROFILES` to answer "what can I do on this order" (would extend the
  agent's `order-ops` tools).
- Editable `notes` section (add `"notes"` to relevant profiles and wire a save flow).
