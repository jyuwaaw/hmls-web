"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { OrderProgressBar } from "@/components/OrderProgressBar";
import { ActivityTimeline } from "@/components/order/ActivityTimeline";
import { DraftBanner } from "@/components/order/DraftBanner";
import { OrderChatPanel } from "@/components/order/OrderChatPanel";
import { OrderDetailsCard } from "@/components/order/OrderDetailsCard";
import { OrderDocumentCard } from "@/components/order/OrderDocumentCard";
import { OrderOpsPanel } from "@/components/order/OrderOpsPanel";
import { OrderSectionsRegion } from "@/components/order/OrderSectionsRegion";
import { TechPrepCard } from "@/components/order/TechPrepCard";
import { askAuthorization } from "@/components/ui/AuthorizeDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { askReason } from "@/components/ui/ReasonDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminOrder } from "@/hooks/useAdmin";
import { useAdminMechanics } from "@/hooks/useAdminMechanics";
import {
  getAdminOrdersListHref,
  parseAdminOrdersFilter,
  parseAdminOrdersSearch,
} from "@/lib/admin-order-filters";
import { useActionInvoker } from "@/lib/order-actions";
import {
  canonicalStatus,
  isTentativeBooking,
  orderSubBadge,
  statusDisplay,
} from "@/lib/status-display";
import { cn } from "@/lib/utils";

/* ── Status Badge (using shadcn Badge) ─────────────────────────────── */

function OrderStatusBadge({
  status,
  config,
  entry,
}: {
  status?: string;
  config?: Record<string, { label: string; color: string }>;
  entry?: { label: string; color: string };
}) {
  const resolved = entry ??
    (status != null ? config?.[status] : undefined) ?? {
      label: status ?? "—",
      color: "bg-neutral-100 text-neutral-500",
    };
  return (
    <Badge variant="outline" className={cn("border-0", resolved.color)}>
      {resolved.label}
    </Badge>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ordersHref = getAdminOrdersListHref(
    parseAdminOrdersFilter(searchParams.get("fromStatus")),
    parseAdminOrdersSearch(searchParams.get("search")),
  );
  const orderId = params.id as string;
  const { data, isLoading, isError, mutate } = useAdminOrder(orderId);

  const { mechanics } = useAdminMechanics();

  // Hooks must run before any early return.
  const orderItems = data?.order.items ?? [];
  const suggestedDurationMinutes = useMemo(
    () =>
      Math.max(
        60,
        Math.round(
          orderItems
            .filter((it) => it.category === "labor")
            .reduce((sum, it) => sum + (it.laborHours ?? 0) * 60, 0),
        ) || 60,
      ),
    [orderItems],
  );

  // `useActionInvoker` is a hook — must run unconditionally before any early
  // return. It tolerates `order: null` during load; no action surface is
  // mounted until data resolves.
  const invoker = useActionInvoker(
    data?.order ?? null,
    orderId,
    mutate,
    askReason,
    askAuthorization,
  );

  if (isLoading) {
    return (
      <div className="space-y-6 py-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-12" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-60 w-full rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data?.order) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Order not found.</p>
        <Link
          href={ordersHref}
          className="text-primary text-sm hover:underline mt-2 inline-block"
        >
          Back to orders
        </Link>
      </div>
    );
  }

  const { order } = data;
  const tentative = isTentativeBooking(order);
  const adminStatus = statusDisplay(order.status, "admin", {
    tentativeBooking: tentative,
  });
  // Derived dual-semantics badge: draft → Pending review / Revising · rev N,
  // approved → Pending schedule / Scheduled.
  const subBadge = orderSubBadge(order);

  const bookingProviderName =
    order.providerId != null
      ? (mechanics.find((m) => m.id === order.providerId)?.name ?? null)
      : null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb + back */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => router.push(ordersHref)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Orders
        </Button>
        <span className="text-xs text-muted-foreground">/</span>
        <span className="text-xs text-foreground font-medium">#{order.id}</span>
      </div>

      {/* Title row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-display font-bold text-foreground">
            Order #{order.id}
          </h1>
          <OrderStatusBadge entry={adminStatus} />
          {subBadge ? (
            <OrderStatusBadge entry={subBadge} />
          ) : (
            order.revisionNumber > 1 && (
              <Badge variant="secondary" className="text-[10px]">
                v{order.revisionNumber}
              </Badge>
            )
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Created <DateTime value={order.createdAt} format="datetime" />
        </span>
      </div>

      {canonicalStatus(order.status) === "draft" && (
        <DraftBanner order={order} invoker={invoker} />
      )}

      {/* Progress bar */}
      <Card className="py-4 gap-0">
        <CardContent>
          <OrderProgressBar
            status={order.status}
            variant="admin"
            tentativeBooking={tentative}
          />
        </CardContent>
      </Card>

      {/* Content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: main details — sections region renders Items, Customer,
            Schedule, Notes with status-aware edit affordances. */}
        <div className="lg:col-span-2 space-y-4">
          {/* Status-contextual estimate/quote PDF panels (moved from aside in
              Phase 4 — they live with the editable content they describe). */}
          <OrderDocumentCard order={order} />

          <OrderSectionsRegion
            order={order}
            revalidate={mutate}
            onSetTime={() => invoker.openDialog("set_time")}
            onReassign={() => invoker.openDialog("reassign")}
            profilePreferred={data.customer?.preferredContact ?? null}
          />

          <TechPrepCard order={order} />

          {/* Embedded staff chat scoped to this order (PR 6). Agent tool
              mutations revalidate the page via SWR mutate. */}
          <OrderChatPanel orderId={order.id} revalidate={mutate} />

          {order.cancellationReason && (
            <Card className="gap-0 py-0 border-destructive/50">
              <CardHeader className="px-4 py-4">
                <CardTitle className="text-sm text-destructive">
                  Cancellation Reason
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-xs text-foreground">
                  {order.cancellationReason}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          <OrderOpsPanel
            order={order}
            invoker={invoker}
            revalidate={mutate}
            suggestedDurationMinutes={suggestedDurationMinutes}
          />
          <OrderDetailsCard order={order} mechanicName={bookingProviderName} />
          <Card className="gap-0 py-0">
            <CardHeader className="px-4 py-4">
              <CardTitle className="text-sm">Activity</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ActivityTimeline events={data.events ?? []} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
