"use client";

import { Calendar, Clock, MapPin, X as XIcon } from "lucide-react";
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
import { type PortalBookingRow, usePortalBookings } from "@/hooks/usePortal";
import { portalPaths } from "@/lib/api-paths";
import { isTentativeBooking, statusDisplay } from "@/lib/status-display";

function BookingCard({
  order,
  onCancel,
  loading,
}: {
  order: PortalBookingRow;
  onCancel: (orderId: number) => void;
  loading: number | null;
}) {
  const canCancel = order.status === "scheduled";
  const vehicle = order.vehicleInfo;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
    : null;
  const firstItem = order.items?.[0]?.name ?? "Service";

  return (
    <div className="bg-surface border border-border rounded-xl p-5 hover:border-border-hover transition-colors">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text">{firstItem}</span>
            <StatusBadge
              entry={statusDisplay(order.status, "portal", {
                tentativeBooking: isTentativeBooking(order),
              })}
            />
          </div>
          {vehicleStr && (
            <p className="text-xs text-text-secondary mt-0.5">{vehicleStr}</p>
          )}
        </div>
        <Link
          href={`/portal/orders/${order.id}`}
          className="text-xs text-text-secondary hover:text-text shrink-0"
        >
          Order #{order.id} →
        </Link>
      </div>

      {/* Date/Time + Location */}
      <div className="space-y-1.5 mb-3">
        {order.scheduledAt && (
          <>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Calendar className="w-3.5 h-3.5 shrink-0" />
              <DateTime value={order.scheduledAt} format="date" />
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span>
                <DateTime value={order.scheduledAt} format="time" />
                {order.durationMinutes ? ` (${order.durationMinutes} min)` : ""}
              </span>
            </div>
          </>
        )}
        {order.location && (
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            <span>{order.location}</span>
          </div>
        )}
      </div>

      {order.intake?.customerNotes && (
        <p className="text-xs text-text-secondary mb-3 bg-surface-alt rounded-lg px-3 py-2">
          {order.intake.customerNotes}
        </p>
      )}

      {order.cancellationReason && (
        <p className="text-xs text-red-500 mb-3">
          Cancellation: {order.cancellationReason}
        </p>
      )}

      {canCancel && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <button
            type="button"
            onClick={() => onCancel(order.id)}
            disabled={loading === order.id}
            className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
          >
            <XIcon className="w-3.5 h-3.5" />
            {loading === order.id ? "Cancelling..." : "Cancel Appointment"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function PortalBookingsPage() {
  const api = useApi();
  const { bookings, isLoading, mutate } = usePortalBookings();
  const [loading, setLoading] = useState<number | null>(null);

  async function handleCancel(orderId: number) {
    const reason = await askReason({
      title: "Cancel appointment",
      description: "Optional: tell us why so we can improve.",
    });
    if (reason === null) return;

    setLoading(orderId);
    try {
      await api.post(
        portalPaths.cancelBooking(orderId),
        reason ? { reason } : {},
      );
      mutate();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to cancel appointment",
      );
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
        title="My Bookings"
        subtitle="View and manage your service appointments."
      />

      {bookings.length === 0 ? (
        <EmptyState
          icon={Calendar}
          message="No bookings yet. Start a chat to schedule an appointment!"
        />
      ) : (
        <div className="space-y-3">
          {bookings.map((order) => (
            <BookingCard
              key={order.id}
              order={order}
              onCancel={handleCancel}
              loading={loading}
            />
          ))}
        </div>
      )}
    </div>
  );
}
