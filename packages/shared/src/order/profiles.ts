import type { OrderStatus } from "./status.ts";

/** Sections of the order detail main column that can be in "edit" mode at a
 *  given status. Independent of {@link ActionId}: an editable section is an
 *  affordance on the page, not a button. */
export type EditableSection =
  | "items"
  | "customer"
  | "schedule"
  | "notes"
  | "diagnosis";

/** Every action the admin can take on an order. Names match the human-visible
 *  intent ("send_to_customer") rather than the target status, because some
 *  actions don't change status (mark_paid, reassign_mechanic, reschedule).
 *
 *  9→7 collapse notes: confirm_booking / confirm_tentative_booking /
 *  reject_booking are gone — there is no `scheduled` state to confirm into.
 *  `approve_walk_in` (draft → approved, fenced) replaces the walk-in
 *  shortcut; booking rejection is just cancel_order. */
export type ActionId =
  | "send_to_customer" // draft → estimated (also re-send after pullback)
  | "approve_estimate" // estimated → approved (admin override of customer; fenced)
  | "decline_estimate" // estimated → declined (admin override)
  | "revise_estimate" // declined → draft
  | "approve_walk_in" // draft → approved (walk-in shortcut; fenced)
  | "reassign_mechanic" // dialog → PATCH /orders/:id/schedule
  | "reschedule" // dialog → PATCH /orders/:id/schedule
  | "set_time" // dialog → PATCH /orders/:id/schedule (when scheduledAt is null)
  | "start_job" // approved → in_progress (requires providerId)
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
      "approve_walk_in",
      "reassign_mechanic",
      "set_time",
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
    actions: ["revise_estimate", "cancel_order"],
    primary: "revise_estimate",
    editableSections: [],
  },
  // Approved absorbs the old `scheduled` state: scheduling is columns
  // (scheduledAt + providerId), the UI derives a "pending schedule" /
  // "scheduled" badge from them, and start_job is gated on providerId.
  approved: {
    status: "approved",
    actions: [
      "start_job",
      "set_time",
      "reschedule",
      "reassign_mechanic",
      "cancel_order",
    ],
    primary: "start_job",
    editableSections: ["schedule"],
  },
  in_progress: {
    status: "in_progress",
    actions: ["complete_job", "cancel_order"],
    primary: "complete_job",
    editableSections: ["diagnosis"],
  },
  completed: {
    status: "completed",
    actions: ["mark_paid"],
    primary: "mark_paid",
    editableSections: ["diagnosis"],
  },
  cancelled: {
    status: "cancelled",
    actions: [],
    editableSections: [],
  },
};
