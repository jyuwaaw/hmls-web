import type { Order } from "@hmls/shared/db/types";
import type { ActionId } from "@hmls/shared/order/profiles";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";
import { isOrderStatus, type OrderStatus } from "@hmls/shared/order/status";

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

export const ACTION_REGISTRY: Readonly<Record<ActionId, ActionDescriptor>> = {
  send_to_customer: {
    id: "send_to_customer",
    label: () => "Send to customer",
    variant: () => "primary",
    // Hides only when the draft has both a slot AND a mechanic — that's when
    // confirm_tentative_booking takes over the banner. Narrower than the
    // page's `isTentativeBooking` (status+scheduledAt only); the extra
    // providerId check avoids letting "Approve & confirm" win when the draft
    // would still fail the server's draft→scheduled gate.
    visible: (o) =>
      !(o.scheduledAt != null && o.providerId != null && o.status === "draft"),
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
      const r = await ctx.askReason({
        title: "Decline estimate",
        description: "Optional reason for the customer.",
      });
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
      const r = await ctx.askReason({
        title: "Reject booking",
        description: "Optional reason for the customer.",
      });
      if (r === null) return;
      await ctx.transitionStatus("cancelled", r || undefined);
    },
  },
  reassign_mechanic: {
    id: "reassign_mechanic",
    label: (o) =>
      o.providerId != null ? "Reassign mechanic" : "Assign mechanic",
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
      const r = await ctx.askReason({
        title: "Cancel order",
        description: "Optional cancellation reason.",
      });
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

export function leadAction(order: Order): ActionDescriptor | undefined {
  if (!isOrderStatus(order.status)) return undefined;
  const profile = STATUS_PROFILES[order.status];
  if (profile.primary) {
    const named = ACTION_REGISTRY[profile.primary];
    if (named?.visible(order)) return named;
  }
  for (const id of profile.actions) {
    const a = ACTION_REGISTRY[id];
    if (a?.visible(order) && a.variant(order) === "primary") return a;
  }
  return undefined;
}
