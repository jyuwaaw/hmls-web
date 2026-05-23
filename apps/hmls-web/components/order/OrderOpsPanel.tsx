"use client";

import type { Order } from "@hmls/shared/db/types";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";
import { isOrderStatus } from "@hmls/shared/order/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  ACTION_REGISTRY,
  leadAction,
  type OrderInvoker,
} from "@/lib/order-actions";
import { ActionButton } from "./ActionButton";
import { DialogHost } from "./DialogHost";

type Props = {
  order: Order;
  invoker: OrderInvoker;
  revalidate(): void;
  suggestedDurationMinutes: number;
};

export function OrderOpsPanel({
  order,
  invoker,
  revalidate,
  suggestedDurationMinutes,
}: Props) {
  // Defensive: a row with an off-machine status (legacy data, in-flight
  // migration) shouldn't crash the page. leadAction handles this too, but
  // STATUS_PROFILES[order.status] would `undefined.actions` below otherwise.
  if (!isOrderStatus(order.status)) return null;
  const profile = STATUS_PROFILES[order.status];

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
