"use client";

import type { Order } from "@hmls/shared/db/types";
import { ReassignBookingDialog } from "@/components/admin/mechanics/ReassignBookingDialog";
import { SetTimeDialog } from "@/components/admin/orders/SetTimeDialog";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import type { DialogId } from "@/lib/order-actions";
import { MarkPaidDialog } from "./MarkPaidDialog";

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
  // TODO(phase-4): this is a second useOrderMutations subscription on the
  // same order — useActionInvoker holds the first. Collapse when MarkPaidDialog
  // lands so there's one mutation hook and one source of busy truth.
  const { setSchedule, savingSchedule, markPaid, savingPayment } =
    useOrderMutations(order.id, revalidate);

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
      {dialog === "mark_paid" && (
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
      )}
    </>
  );
}
