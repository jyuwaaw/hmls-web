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
