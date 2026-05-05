// Display layer for order status. Tailwind class names + human-readable
// labels live here, web-only. State-machine constants (TRANSITIONS,
// EDITABLE_STATUSES, ORDER_MAIN_STEPS, getOrderStepState, ...) come from
// `@hmls/shared/order/status` and must NOT be redefined here.

import { isOrderStatus, type OrderStatus } from "@hmls/shared/order/status";

export interface StatusConfig {
  label: string;
  color: string;
}

export const ORDER_STATUS: Record<OrderStatus, StatusConfig> = {
  draft: {
    label: "Draft",
    color:
      "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  },
  estimated: {
    label: "Estimated",
    color:
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  },
  approved: {
    label: "Approved",
    color:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  declined: {
    label: "Declined",
    color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  },
  revised: {
    label: "Revised",
    color:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
  scheduled: {
    label: "Scheduled",
    color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  },
  in_progress: {
    label: "In Progress",
    color:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  },
  completed: {
    label: "Completed",
    color:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  },
  cancelled: {
    label: "Cancelled",
    color:
      "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  },
};

/** Portal-facing labels (admin/portal share colors but differ on phrasing). */
export const PORTAL_ORDER_STATUS: Record<OrderStatus, StatusConfig> = {
  ...ORDER_STATUS,
  draft: { ...ORDER_STATUS.draft, label: "Preparing" },
  estimated: { ...ORDER_STATUS.estimated, label: "Estimate Ready" },
  revised: { ...ORDER_STATUS.revised, label: "Updated Estimate" },
};

export const ORDER_STEP_LABELS_ADMIN: Record<OrderStatus, string> = {
  draft: "Draft",
  estimated: "Estimated",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  completed: "Completed",
  declined: "Declined",
  revised: "Revised",
  cancelled: "Cancelled",
};

export const ORDER_STEP_LABELS_PORTAL: Record<OrderStatus, string> = {
  draft: "Preparing",
  estimated: "Estimate Ready",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  completed: "Complete",
  declined: "Declined",
  revised: "Updated Estimate",
  cancelled: "Cancelled",
};

/** Tentative-booking display for chat-flow drafts that already have a slot
 *  + auto-assigned mechanic but are still waiting on shop review. The
 *  state-machine status is `draft`, but we surface it to the customer as
 *  "Pending Confirmation" so the UX matches what just happened in chat
 *  (without lying that the booking is locked). Admin sees the same
 *  treatment so the review queue is visually distinct from plain drafts. */
const PENDING_CONFIRMATION_CONFIG: StatusConfig = {
  label: "Pending Confirmation",
  color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

/** True when a draft has accumulated chat-flow scheduling — it is
 *  tentatively booked, not just an estimate. */
export function isTentativeBooking(order: {
  status: string;
  scheduledAt?: string | Date | null;
}): boolean {
  return order.status === "draft" && order.scheduledAt != null;
}

/** Lookup helper that handles unknown DB status values gracefully.
 *  Use this from JSX instead of indexing the records directly.
 *  Pass `tentativeBooking: true` when the order is a chat-flow draft with a
 *  slot already attached — it returns "Pending Confirmation" instead of the
 *  bare draft/Preparing label. */
export function statusDisplay(
  status: string,
  surface: "admin" | "portal" = "admin",
  opts?: { tentativeBooking?: boolean },
): StatusConfig {
  if (opts?.tentativeBooking && status === "draft") {
    return PENDING_CONFIRMATION_CONFIG;
  }
  const map = surface === "portal" ? PORTAL_ORDER_STATUS : ORDER_STATUS;
  return isOrderStatus(status)
    ? map[status]
    : {
        label: status,
        color: "bg-neutral-100 text-neutral-500",
      };
}
