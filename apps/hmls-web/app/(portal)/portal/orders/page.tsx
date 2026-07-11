"use client";

import { Check, ClipboardList, X as XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DateTime } from "@/components/ui/DateTime";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { askReason } from "@/components/ui/ReasonDialog";
import { Spinner } from "@/components/ui/Spinner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useApi } from "@/hooks/useApi";
import { type PortalOrder, usePortalOrders } from "@/hooks/usePortal";
import { portalPaths } from "@/lib/api-paths";
import {
  canonicalStatus,
  historicalStatusLabel,
  isBookedOrder,
  isTentativeBooking,
  statusDisplay,
} from "@/lib/status-display";

function OrderCard({
  order,
  onAction,
  loading,
}: {
  order: PortalOrder;
  onAction: (orderId: number, action: "approve" | "decline") => void;
  loading: number | null;
}) {
  const canApproveDecline = canonicalStatus(order.status) === "estimated";
  const tentative = isTentativeBooking(order);
  const badgeEntry = statusDisplay(order.status, "portal", {
    tentativeBooking: tentative,
    scheduledBooking: isBookedOrder(order),
  });

  return (
    <div className="bg-surface border border-border rounded-xl p-5 hover:border-border-hover transition-colors">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href={`/portal/orders/${order.id}`}
              className="text-sm font-semibold text-text hover:text-red-primary transition-colors"
            >
              Order #{order.id}
            </Link>
            <StatusBadge entry={badgeEntry} />
          </div>
          <p className="text-xs text-text-secondary mt-0.5">
            <DateTime value={order.createdAt} format="datetime" />
          </p>
        </div>
        <Link
          href={`/portal/orders/${order.id}`}
          className="text-xs text-text-secondary hover:text-text transition-colors shrink-0"
        >
          View →
        </Link>
      </div>

      {order.cancellationReason && (
        <p className="text-xs text-red-500 mb-3">
          Reason: {order.cancellationReason}
        </p>
      )}

      {/* Status timeline */}
      {Array.isArray(order.statusHistory) && order.statusHistory.length > 0 && (
        <div className="border-t border-border pt-3 mb-3">
          <p className="text-xs font-medium text-text-secondary mb-2">
            History
          </p>
          <div className="space-y-1">
            {order.statusHistory.map((entry) => (
              <div
                key={`${entry.status}-${entry.timestamp}`}
                className="flex items-center gap-2 text-xs text-text-secondary"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-text-secondary shrink-0" />
                {/* History is immutable — legacy entries keep their
                    historical label (Scheduled / Updated Estimate). */}
                <span>{historicalStatusLabel(entry.status, "portal")}</span>
                <span className="text-text-secondary/60">
                  {new Date(entry.timestamp).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Approve / Decline buttons */}
      {canApproveDecline && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <button
            type="button"
            onClick={() => onAction(order.id, "approve")}
            disabled={loading === order.id}
            className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            Approve Estimate
          </button>
          <button
            type="button"
            onClick={() => onAction(order.id, "decline")}
            disabled={loading === order.id}
            className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
          >
            <XIcon className="w-3.5 h-3.5" />
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export default function PortalOrdersPage() {
  const api = useApi();
  const { orders, isLoading, mutate } = usePortalOrders();
  const [loading, setLoading] = useState<number | null>(null);

  async function handleAction(orderId: number, action: "approve" | "decline") {
    if (action === "decline") {
      const reason = await askReason({
        title: "Decline estimate",
        description: "Optional: let the shop know what didn't work.",
      });
      if (reason === null) return;
      await doAction(orderId, action, reason || undefined);
    } else {
      await doAction(orderId, action);
    }
  }

  async function doAction(
    orderId: number,
    action: "approve" | "decline",
    reason?: string,
  ) {
    setLoading(orderId);
    try {
      const path =
        action === "approve"
          ? portalPaths.approve(orderId)
          : portalPaths.decline(orderId);
      await api.post(path, reason ? { reason } : {});
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${action} order`);
    } finally {
      setLoading(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="My Orders"
        subtitle="Track your service orders from estimate to completion."
      />

      {orders.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          message="No orders yet. Start a chat to get an estimate!"
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onAction={handleAction}
              loading={loading}
            />
          ))}
        </div>
      )}
    </div>
  );
}
