"use client";

import { CheckCircle, ClipboardList, Loader } from "lucide-react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortalCustomer, usePortalOrders } from "@/hooks/usePortal";
import { formatCents } from "@/lib/format";
import {
  canonicalStatus,
  isBookedOrder,
  isTentativeBooking,
  statusDisplay,
} from "@/lib/status-display";

function SummaryCard({
  label,
  count,
  icon: Icon,
  href,
  color,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  color: string;
}) {
  return (
    <Link href={href}>
      <Card className="p-5 hover:border-primary transition-colors group">
        <CardContent className="p-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{label}</span>
            <div className={`p-2 rounded-lg ${color}`}>
              <Icon className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-display font-bold text-foreground">
            {count}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

function SummaryCardSkeleton() {
  return (
    <Card className="p-5">
      <CardContent className="p-0">
        <div className="flex items-center justify-between mb-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
        <Skeleton className="h-8 w-12" />
      </CardContent>
    </Card>
  );
}

export default function PortalDashboard() {
  const { customer, isLoading: customerLoading } = usePortalCustomer();
  const { orders, isLoading: ordersLoading } = usePortalOrders();

  const isLoading = customerLoading || ordersLoading;

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-8 w-64 mb-1" />
        <Skeleton className="h-4 w-48 mb-8" />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
          <SummaryCardSkeleton />
          <SummaryCardSkeleton />
          <SummaryCardSkeleton />
        </div>

        <Skeleton className="h-6 w-32 mb-4" />
        <Card>
          <CardContent className="divide-y divide-border">
            {["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4"].map(
              (id) => (
                <div key={id} className="flex items-center gap-4 py-3">
                  <Skeleton className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <Skeleton className="h-4 w-32 mb-1" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-3 w-20 shrink-0" />
                </div>
              ),
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const pendingAction = orders.filter((o) => o.status === "estimated").length;

  const activeOrders = orders.filter((o) => {
    const s = canonicalStatus(o.status);
    return s === "approved" || s === "in_progress";
  }).length;

  const completed = orders.filter((o) => o.status === "completed").length;

  const recentOrders = [...orders]
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() -
        new Date(a.updatedAt ?? 0).getTime(),
    )
    .slice(0, 8);

  return (
    <div>
      <h1 className="text-2xl font-display font-bold text-foreground mb-1">
        {customer?.name ? `Welcome back, ${customer.name}` : "Welcome back"}
      </h1>
      <p className="text-sm text-muted-foreground mb-8">
        Here&apos;s an overview of your account.
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
        <SummaryCard
          label="Pending Action"
          count={pendingAction}
          icon={ClipboardList}
          href="/portal/orders"
          color="bg-red-500/10 text-red-500 dark:bg-red-900/30 dark:text-red-400"
        />
        <SummaryCard
          label="Active Orders"
          count={activeOrders}
          icon={Loader}
          href="/portal/orders"
          color="bg-red-500/10 text-red-500 dark:bg-red-900/30 dark:text-red-400"
        />
        <SummaryCard
          label="Completed"
          count={completed}
          icon={CheckCircle}
          href="/portal/orders"
          color="bg-red-500/10 text-red-500 dark:bg-red-900/30 dark:text-red-400"
        />
      </div>

      {/* Recent orders */}
      <h2 className="text-lg font-display font-semibold text-foreground mb-4">
        Recent Orders
      </h2>
      {recentOrders.length === 0 ? (
        <Card className="p-8 text-center">
          <CardContent className="p-0">
            <p className="text-muted-foreground text-sm">No orders yet.</p>
            <Link
              href="/chat"
              className="inline-block mt-3 text-sm text-primary hover:text-primary/80 font-medium"
            >
              Get your first estimate &rarr;
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0">
          <CardContent className="p-0 divide-y divide-border">
            {recentOrders.map((order) => {
              const statusConfig = statusDisplay(order.status, "portal", {
                tentativeBooking: isTentativeBooking(order),
                scheduledBooking: isBookedOrder(order),
              });
              return (
                <Link
                  key={order.id}
                  href={`/portal/orders/${order.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-muted transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  <ClipboardList className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">
                      Order #{order.id}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {statusConfig.label}
                      {order.subtotalCents > 0
                        ? ` · ${formatCents(order.subtotalCents)}`
                        : ""}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    <DateTime value={order.updatedAt} format="datetime" />
                  </span>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
