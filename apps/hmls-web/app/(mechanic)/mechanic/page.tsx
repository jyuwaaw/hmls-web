"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  askPayment,
  CollectPaymentDialog,
} from "@/components/mechanic/CollectPaymentDialog";
import {
  PREFERRED_ICON,
  PREFERRED_LABEL,
} from "@/components/order/sections/CustomerSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { askReason } from "@/components/ui/ReasonDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { type MechanicOrder, useMechanicOrders } from "@/hooks/useMechanic";
import { formatDate, formatTime } from "@/lib/format";
import {
  invokeMechanicJobAction,
  type MechanicJobAction,
  mechanicJobAction,
} from "@/lib/mechanic-job-actions";
import { canonicalStatus, statusDisplay } from "@/lib/status-display";
import { cn } from "@/lib/utils";

function vehicleLabel(o: MechanicOrder) {
  const v = o.vehicleInfo;
  if (!v) return null;
  return [v.year, v.make, v.model].filter(Boolean).join(" ");
}

function partitionBySchedule(orders: MechanicOrder[]) {
  const pending: MechanicOrder[] = [];
  const byDay = new Map<string, MechanicOrder[]>();
  for (const o of orders) {
    if (!o.scheduledAt) {
      pending.push(o);
      continue;
    }
    const key = new Date(o.scheduledAt).toDateString();
    const existing = byDay.get(key);
    if (existing) existing.push(o);
    else byDay.set(key, [o]);
  }
  for (const [key, group] of byDay) {
    byDay.set(
      key,
      group.sort((a, b) => {
        const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
        const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
        return ta - tb;
      }),
    );
  }
  pending.sort((a, b) => a.id - b.id);
  return { pending, byDay };
}

function durationLabel(minutes: number | null): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function OrderCard({
  order,
  onAction,
}: {
  order: MechanicOrder;
  onAction: (order: MechanicOrder, action: MechanicJobAction) => Promise<void>;
}) {
  const vehicle = vehicleLabel(order);
  const time = order.scheduledAt
    ? formatTime(order.scheduledAt)
    : durationLabel(order.durationMinutes);
  const statusConfig = statusDisplay(order.status);
  const firstItem = order.items?.[0]?.name ?? "Service";
  const action = mechanicJobAction(order.status);
  // In-flight guard: double-click fires one request; the backend state guard
  // rejects any duplicate that slips through anyway.
  const [busy, setBusy] = useState(false);

  return (
    <Card className="py-0">
      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="shrink-0 text-center sm:w-16">
          <span className="text-xs font-semibold text-muted-foreground bg-muted border border-border rounded-lg px-2 py-1 inline-block">
            {time}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-foreground">
              #{order.id}
            </span>
            <Badge className={cn("border-transparent", statusConfig.color)}>
              {statusConfig.label}
            </Badge>
          </div>
          <p className="text-sm text-foreground truncate">
            {order.contactName ?? "Customer"}
          </p>
          {/* The mechanic is the one actually calling/texting before arrival —
              show the number AND how the customer asked to be reached. */}
          {order.contactPhone && (
            <p className="text-xs mt-0.5 flex items-center gap-2">
              <a
                href={`tel:${order.contactPhone}`}
                className="font-medium text-foreground underline underline-offset-2"
              >
                {order.contactPhone}
              </a>
              {order.contactPreferred && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  {(() => {
                    const Icon = PREFERRED_ICON[order.contactPreferred];
                    return <Icon className="w-3 h-3" />;
                  })()}
                  {PREFERRED_LABEL[order.contactPreferred]}
                </span>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">{firstItem}</p>
          {vehicle && (
            <p className="text-xs text-muted-foreground">{vehicle}</p>
          )}
          {order.location && (
            <p className="text-xs text-muted-foreground truncate">
              {order.location}
            </p>
          )}
          {order.intake?.customerNotes && (
            <p className="text-xs text-muted-foreground mt-1 italic truncate">
              &ldquo;{order.intake.customerNotes}&rdquo;
            </p>
          )}
        </div>

        {action && (
          <div className="shrink-0 flex sm:self-center">
            <Button
              size="lg"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onAction(order, action);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? action.busyLabel : action.label}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MechanicOrdersPage() {
  const fromDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  const { orders, isLoading, mutate, transitionOrder, recordPayment } =
    useMechanicOrders(fromDate);

  async function handleAction(order: MechanicOrder, action: MechanicJobAction) {
    try {
      await invokeMechanicJobAction(
        action,
        order,
        (to, confirmedDiagnosis) =>
          transitionOrder(order.id, to, confirmedDiagnosis),
        askReason,
        // Skippable on-the-spot payment after Complete. A failed payment
        // write re-opens the dialog (retry) and never rolls back the
        // completion — admin mark-paid is the fallback.
        {
          ask: ({ error }) =>
            askPayment({
              defaultAmountCents: order.subtotalCents ?? 0,
              error,
            }),
          record: async (payment) => {
            await recordPayment(order.id, payment);
            toast.success("Payment recorded");
          },
        },
      );
    } catch (e) {
      // Conflict (double-click / concurrent admin action) or network error:
      // surface non-fatally and refetch so the card reflects reality.
      toast.error(e instanceof Error ? e.message : "Failed to update job");
      await mutate();
    }
  }

  // approved + a slot = the confirmed booking (day groups below); approved
  // without a slot lands in "Pending schedule". canonicalStatus keeps
  // window-period legacy 'scheduled' rows visible.
  const upcoming = orders.filter((o) => {
    const s = canonicalStatus(o.status);
    return s === "approved" || s === "in_progress";
  });
  const { pending, byDay } = partitionBySchedule(upcoming);
  const sortedDays = [...byDay.keys()].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  );

  if (isLoading) {
    return (
      <div className="space-y-10">
        <Skeleton className="h-8 w-40" />
        <div className="space-y-2">
          {["s1", "s2", "s3"].map((id) => (
            <Skeleton key={id} className="h-20 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <CollectPaymentDialog />
      <h1 className="text-2xl font-display font-bold text-foreground">
        My Jobs
      </h1>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3">Upcoming</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming jobs assigned.
          </p>
        ) : (
          <div className="space-y-6">
            {pending.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-2">
                  Pending schedule
                </h3>
                <div className="space-y-2">
                  {pending.map((o) => (
                    <OrderCard key={o.id} order={o} onAction={handleAction} />
                  ))}
                </div>
              </div>
            )}
            {sortedDays.map((day) => (
              <div key={day}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {formatDate(new Date(day).toISOString())}
                </h3>
                <div className="space-y-2">
                  {byDay.get(day)?.map((o) => (
                    <OrderCard key={o.id} order={o} onAction={handleAction} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
