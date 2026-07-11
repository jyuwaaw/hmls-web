"use client";

import {
  AlertTriangle,
  ArrowRight,
  Clock,
  DollarSign,
  PlayCircle,
  Users,
} from "lucide-react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminDashboard } from "@/hooks/useAdmin";
import { formatCents } from "@/lib/format";

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  href,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  href?: string;
}) {
  const card = (
    <Card className="gap-0 p-5 h-full">
      <CardContent className="p-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-muted-foreground">{label}</span>
          <div className={`p-2 rounded-lg ${color}`}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
        <p className="text-2xl font-display font-bold text-foreground">
          {value}
        </p>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-90 transition-opacity">
      {card}
    </Link>
  ) : (
    card
  );
}

function StatCardSkeleton() {
  return (
    <Card className="gap-0 p-5">
      <CardContent className="p-0">
        <div className="flex items-center justify-between mb-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
        <Skeleton className="h-8 w-24" />
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton className="h-8 w-40 mb-1" />
      <Skeleton className="h-4 w-56 mb-8" />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-10">
        {["stat-1", "stat-2", "stat-3", "stat-4", "stat-5"].map((id) => (
          <StatCardSkeleton key={id} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {["col-1", "col-2"].map((colId) => (
          <div key={colId}>
            <div className="flex items-center justify-between mb-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-14" />
            </div>
            <Card className="gap-0 p-0">
              <CardContent className="p-0 divide-y divide-border">
                {["row-1", "row-2", "row-3"].map((rowId) => (
                  <div key={rowId} className="px-4 py-3">
                    <Skeleton className="h-4 w-3/4 mb-1.5" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { data, isLoading } = useAdminDashboard();

  if (isLoading || !data) {
    return <DashboardSkeleton />;
  }

  const { stats, upcomingOrders, recentCustomers } = data;

  return (
    <div>
      <h1 className="text-2xl font-display font-bold text-foreground mb-1">
        Dashboard
      </h1>
      <p className="text-sm text-muted-foreground mb-8">
        Business overview at a glance.
      </p>

      {/* Pending Review banner */}
      {stats.pendingReview > 0 && (
        <Link href="/admin/orders?status=draft" className="block mb-6 group">
          <Card className="border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 gap-0 py-0 transition-colors hover:bg-amber-100 dark:hover:bg-amber-950/30">
            <CardContent className="px-4 py-3 flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  {stats.pendingReview} AI-drafted estimate
                  {stats.pendingReview === 1 ? "" : "s"} pending review
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300/90">
                  Review and send to customers
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 group-hover:translate-x-0.5 transition-transform" />
            </CardContent>
          </Card>
        </Link>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-10">
        <StatCard
          label="Customers"
          value={stats.customers}
          icon={Users}
          href="/admin/customers"
          color="bg-red-500/10 text-red-500 dark:bg-red-900/30 dark:text-red-400"
        />
        <StatCard
          label="Pending Review"
          value={stats.pendingReview}
          icon={AlertTriangle}
          href="/admin/orders?status=draft"
          color="bg-amber-500/10 text-amber-500 dark:bg-amber-900/30 dark:text-amber-400"
        />
        <StatCard
          label="Awaiting Approval"
          value={stats.pendingApprovals}
          icon={Clock}
          href="/admin/orders?status=estimated"
          color="bg-indigo-500/10 text-indigo-500 dark:bg-indigo-900/30 dark:text-indigo-400"
        />
        <StatCard
          label="Active Jobs"
          value={stats.activeJobs}
          icon={PlayCircle}
          href="/admin/orders?status=in_progress"
          color="bg-emerald-500/10 text-emerald-500 dark:bg-emerald-900/30 dark:text-emerald-400"
        />
        <StatCard
          label="Revenue (30d)"
          value={formatCents(stats.revenue30d)}
          icon={DollarSign}
          color="bg-green-500/10 text-green-500 dark:bg-green-900/30 dark:text-green-400"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming bookings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">
              Upcoming Bookings
            </h2>
            <Link
              href="/admin/orders?status=approved"
              className="text-xs text-primary hover:text-primary/80 font-medium"
            >
              View all
            </Link>
          </div>
          {upcomingOrders.length === 0 ? (
            <Card className="gap-0 p-6 text-center">
              <CardContent className="p-0">
                <p className="text-xs text-muted-foreground">
                  No upcoming bookings.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card className="gap-0 p-0">
              <CardContent className="p-0 divide-y divide-border">
                {upcomingOrders.map((o) => {
                  const vehicle = o.vehicleInfo;
                  const vehicleStr = vehicle
                    ? [vehicle.year, vehicle.make, vehicle.model]
                        .filter(Boolean)
                        .join(" ")
                    : null;
                  return (
                    <Link
                      key={o.id}
                      href={`/admin/orders/${o.id}`}
                      className="block px-4 py-3 hover:bg-muted transition-colors"
                    >
                      <p className="text-sm text-foreground font-medium truncate">
                        #{o.id}
                        {vehicleStr ? ` · ${vehicleStr}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <DateTime value={o.scheduledAt} format="date" />{" "}
                        &middot; {o.contactName ?? "Unknown"}
                      </p>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Recent customers */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">
              Recent Customers
            </h2>
            <Link
              href="/admin/customers"
              className="text-xs text-primary hover:text-primary/80 font-medium"
            >
              View all
            </Link>
          </div>
          {recentCustomers.length === 0 ? (
            <Card className="gap-0 p-6 text-center">
              <CardContent className="p-0">
                <p className="text-xs text-muted-foreground">
                  No customers yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card className="gap-0 p-0 overflow-hidden">
              <CardContent className="p-0 divide-y divide-border">
                {recentCustomers.map((c) => (
                  <Link
                    key={c.id}
                    href={`/admin/customers?id=${c.id}`}
                    className="block px-4 py-3 hover:bg-muted transition-colors"
                  >
                    <p className="text-sm text-foreground font-medium truncate">
                      {c.name ?? "Unnamed"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.email ?? c.phone ?? "No contact info"}
                    </p>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
