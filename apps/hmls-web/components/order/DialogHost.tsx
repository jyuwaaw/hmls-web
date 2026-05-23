"use client";

import type { Order } from "@hmls/shared/db/types";
import { ReassignBookingDialog } from "@/components/admin/mechanics/ReassignBookingDialog";
import { SetTimeDialog } from "@/components/admin/orders/SetTimeDialog";
import type { OrderInvoker } from "@/lib/order-actions";
import { MarkPaidDialog } from "./MarkPaidDialog";

type Props = {
  order: Order;
  invoker: OrderInvoker;
  /** Trigger SWR re-fetch after a dialog mutates the order. */
  revalidate(): void;
  /** Suggested duration in minutes for SetTimeDialog when scheduledAt is null. */
  suggestedDurationMinutes: number;
};

export function DialogHost({
  order,
  invoker,
  revalidate,
  suggestedDurationMinutes,
}: Props) {
  return (
    <>
      <ReassignBookingDialog
        order={order}
        open={invoker.dialog === "reassign"}
        onOpenChange={(open) => {
          if (!open) invoker.closeDialog();
        }}
        onAssigned={() => {
          revalidate();
          invoker.closeDialog();
        }}
      />
      {invoker.dialog === "set_time" && (
        <SetTimeDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) invoker.closeDialog();
          }}
          initialScheduledAt={order.scheduledAt ?? null}
          initialDurationMinutes={order.durationMinutes ?? null}
          suggestedDurationMinutes={suggestedDurationMinutes}
          initialLocation={order.location ?? null}
          saving={invoker.savingSchedule}
          onSave={async (scheduledAt, durationMinutes, location) => {
            await invoker.setSchedule(scheduledAt, durationMinutes, location);
            invoker.closeDialog();
          }}
        />
      )}
      {invoker.dialog === "mark_paid" && (
        <MarkPaidDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) invoker.closeDialog();
          }}
          defaultAmountCents={order.subtotalCents ?? 0}
          saving={invoker.savingPayment}
          onSubmit={async (args) => {
            await invoker.markPaid(args);
            invoker.closeDialog();
          }}
        />
      )}
    </>
  );
}
