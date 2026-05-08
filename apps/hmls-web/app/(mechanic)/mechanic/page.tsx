"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type MechanicOrder, useMechanicOrders } from "@/hooks/useMechanic";
import { formatDate, formatTime } from "@/lib/format";
import { statusDisplay } from "@/lib/status-display";
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

function OrderCard({ order }: { order: MechanicOrder }) {
  const vehicle = vehicleLabel(order);
  const time = order.scheduledAt
    ? formatTime(order.scheduledAt)
    : durationLabel(order.durationMinutes);
  const statusConfig = statusDisplay(order.status);
  const firstItem = order.items?.[0]?.name ?? "Service";

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

  const { orders, isLoading } = useMechanicOrders(fromDate);

  // Include `approved` so an order assigned-but-not-yet-confirmed by the
  // shop still surfaces here. The mechanic needs to know it's coming even
  // before the admin clicks "Confirm booking".
  const upcoming = orders.filter((o) =>
    ["approved", "scheduled", "in_progress"].includes(o.status),
  );
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
                    <OrderCard key={o.id} order={o} />
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
                    <OrderCard key={o.id} order={o} />
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
