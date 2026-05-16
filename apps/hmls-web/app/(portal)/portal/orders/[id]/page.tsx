"use client";

import type { OrderEvent, OrderItem } from "@hmls/shared/db/types";
import { ArrowLeft, Check, Printer, X as XIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FixoCtaBanner } from "@/components/FixoCtaBanner";
import { OrderProgressBar } from "@/components/OrderProgressBar";
import { DateTime } from "@/components/ui/DateTime";
import { askReason } from "@/components/ui/ReasonDialog";
import { Spinner } from "@/components/ui/Spinner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useApi } from "@/hooks/useApi";
import { usePortalOrder } from "@/hooks/usePortal";
import { portalPaths } from "@/lib/api-paths";
import { formatCents } from "@/lib/format";
import { isTentativeBooking, statusDisplay } from "@/lib/status-display";

/* ── Timeline helpers ─────────────────────────────────────────────────── */

function eventDescription(event: OrderEvent): string {
  switch (event.eventType) {
    case "status_change":
      if (event.toStatus) {
        const label = statusDisplay(event.toStatus, "portal").label;
        return `Status updated to: ${label}`;
      }
      return "Status updated";
    case "items_edited":
      return "Service items were updated";
    default:
      return event.eventType.replace(/_/g, " ");
  }
}

function StatusTimeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-text-secondary py-2">No activity yet.</p>;
  }
  return (
    <div className="space-y-0">
      {events.map((event, idx) => (
        <div key={event.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="w-2 h-2 rounded-full bg-text-secondary mt-1.5 shrink-0" />
            {idx < events.length - 1 && (
              <div className="w-px flex-1 bg-border mt-1 mb-1" />
            )}
          </div>
          <div className="pb-3 min-w-0 flex-1">
            <p className="text-xs text-text leading-snug">
              {eventDescription(event)}
            </p>
            <span className="text-[10px] text-text-secondary">
              <DateTime value={event.createdAt} format="datetime" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Print receipt ────────────────────────────────────────────────────── */

function PrintReceipt({
  order,
}: {
  order: {
    id: number;
    status: string;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    contactAddress: string | null;
    vehicleInfo: { year?: string; make?: string; model?: string } | null;
    items: OrderItem[];
    subtotalCents: number;
    priceRangeLowCents: number | null;
    priceRangeHighCents: number | null;
    notes: string | null;
    createdAt: string | null;
  };
}) {
  const vehicle = order.vehicleInfo;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
    : null;
  const statusLabel = statusDisplay(order.status, "portal").label;

  return (
    <div className="hidden print:block text-black bg-white p-8 max-w-2xl mx-auto font-sans">
      {/* Header */}
      <div className="flex justify-between items-start mb-6 border-b border-gray-200 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">HMLS</h1>
          <p className="text-sm text-gray-500">Mobile Mechanic Service</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-semibold">Order #{order.id}</p>
          <p className="text-gray-500">
            <DateTime value={order.createdAt} format="date" />
          </p>
          <p className="text-gray-500">{statusLabel}</p>
        </div>
      </div>

      {/* Contact + Vehicle */}
      <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
        <div>
          <p className="font-semibold text-gray-700 mb-1">Customer</p>
          {order.contactName && <p>{order.contactName}</p>}
          {order.contactEmail && (
            <p className="text-gray-600">{order.contactEmail}</p>
          )}
          {order.contactPhone && (
            <p className="text-gray-600">{order.contactPhone}</p>
          )}
          {order.contactAddress && (
            <p className="text-gray-600">{order.contactAddress}</p>
          )}
        </div>
        {vehicleStr && (
          <div>
            <p className="font-semibold text-gray-700 mb-1">Vehicle</p>
            <p>{vehicleStr}</p>
          </div>
        )}
      </div>

      {/* Line items */}
      {order.items.length > 0 && (
        <table className="w-full text-sm mb-4">
          <thead>
            <tr className="border-b border-gray-300">
              <th className="text-left py-1.5 font-semibold text-gray-700">
                Service
              </th>
              <th className="text-right py-1.5 font-semibold text-gray-700 w-12">
                Qty
              </th>
              <th className="text-right py-1.5 font-semibold text-gray-700 w-24">
                Unit
              </th>
              <th className="text-right py-1.5 font-semibold text-gray-700 w-24">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-gray-100">
                <td className="py-1.5">
                  <span className="text-xs uppercase text-gray-400 mr-2">
                    {item.category}
                  </span>
                  {item.name}
                  {item.description && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.description}
                    </p>
                  )}
                </td>
                <td className="py-1.5 text-right text-gray-600">
                  {item.quantity}
                </td>
                <td className="py-1.5 text-right text-gray-600">
                  {formatCents(item.unitPriceCents)}
                </td>
                <td className="py-1.5 text-right font-medium">
                  {formatCents(item.totalCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300">
              <td colSpan={3} className="py-2 text-right font-semibold">
                Subtotal
              </td>
              <td className="py-2 text-right font-bold text-lg">
                {formatCents(order.subtotalCents)}
              </td>
            </tr>
            {(order.priceRangeLowCents != null ||
              order.priceRangeHighCents != null) && (
              <tr>
                <td
                  colSpan={3}
                  className="text-right text-xs text-gray-500 pb-1"
                >
                  Estimated range
                </td>
                <td className="text-right text-xs text-gray-500 pb-1">
                  {order.priceRangeLowCents != null
                    ? formatCents(order.priceRangeLowCents)
                    : "—"}{" "}
                  –{" "}
                  {order.priceRangeHighCents != null
                    ? formatCents(order.priceRangeHighCents)
                    : "—"}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      )}

      {order.notes && (
        <p className="text-xs text-gray-500 italic mb-4">{order.notes}</p>
      )}

      <p className="text-xs text-gray-400 text-center pt-4 border-t border-gray-100">
        Thank you for choosing HMLS Mobile Mechanic · hmls.autos
      </p>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function PortalOrderDetailPage() {
  const api = useApi();
  const params = useParams();
  const orderId = params.id as string;
  const { data, isLoading, isError, mutate } = usePortalOrder(orderId);
  const [actionLoading, setActionLoading] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (isError || !data?.order) {
    return (
      <div className="text-center py-20">
        <p className="text-text-secondary">Order not found.</p>
        <Link
          href="/portal/orders"
          className="text-red-primary text-sm hover:underline mt-2 inline-block"
        >
          Back to orders
        </Link>
      </div>
    );
  }

  const { order, events } = data;
  const items: OrderItem[] = order.items ?? [];
  const vehicle = order.vehicleInfo;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
    : null;
  const canApproveDecline = order.status === "estimated";
  const tentative = isTentativeBooking(order);
  const portalStatus = statusDisplay(order.status, "portal", {
    tentativeBooking: tentative,
  });

  async function handleAction(action: "approve" | "decline") {
    if (action === "decline") {
      const reason = await askReason({
        title: "Decline estimate",
        description: "Optional: let the shop know what didn't work.",
      });
      if (reason === null) return;
      await doAction(action, reason || undefined);
    } else {
      await doAction(action);
    }
  }

  async function doAction(action: "approve" | "decline", reason?: string) {
    setActionLoading(true);
    try {
      const path =
        action === "approve"
          ? portalPaths.approve(order.id)
          : portalPaths.decline(order.id);
      await api.post(path, reason ? { reason } : {});
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${action} order`);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <>
      {/* Print receipt — only visible when printing */}
      <PrintReceipt order={{ ...order, items }} />

      {/* Screen content — hidden when printing */}
      <div className="space-y-6 print:hidden">
        {/* Breadcrumb */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/portal/orders"
              className="flex items-center gap-1 text-xs text-text-secondary hover:text-text transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              My Orders
            </Link>
            <span className="text-xs text-text-secondary">/</span>
            <span className="text-xs text-text font-medium">#{order.id}</span>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text transition-colors border border-border rounded-lg px-3 py-1.5"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
        </div>

        {/* Title row */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-display font-bold text-text">
              Order #{order.id}
            </h1>
            <StatusBadge entry={portalStatus} />
          </div>
          <span className="text-xs text-text-secondary">
            Created <DateTime value={order.createdAt} format="datetime" />
          </span>
        </div>

        {tentative && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
            <p className="font-semibold">Pending shop confirmation</p>
            <p className="mt-0.5 text-amber-800 dark:text-amber-200/90">
              Our team is reviewing the AI-drafted estimate. Once they confirm
              the line items and pricing, your appointment will be locked in and
              you'll get a notification.
            </p>
          </div>
        )}

        {/* Progress bar */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <OrderProgressBar
            status={order.status}
            variant="portal"
            tentativeBooking={tentative}
          />
        </div>

        {/* Fixo CTA — only shown when the order is in a terminal-decline
            state. Mirrors the email CTA so the customer journey is
            consistent whether they arrived via inbox or direct portal. */}
        {(order.status === "declined" || order.status === "cancelled") && (
          <FixoCtaBanner channelDetail={`portal_${order.status}`} />
        )}

        {/* Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left column */}
          <div className="lg:col-span-2 space-y-4">
            {/* Contact info */}
            <div className="bg-surface border border-border rounded-xl p-4">
              <h2 className="text-sm font-semibold text-text mb-3">Contact</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-text-secondary">Name</span>
                  <p className="text-text font-medium">
                    {order.contactName ?? "—"}
                  </p>
                </div>
                <div>
                  <span className="text-text-secondary">Email</span>
                  <p className="text-text font-medium">
                    {order.contactEmail ?? "—"}
                  </p>
                </div>
                <div>
                  <span className="text-text-secondary">Phone</span>
                  <p className="text-text font-medium">
                    {order.contactPhone ?? "—"}
                  </p>
                </div>
                <div>
                  <span className="text-text-secondary">Address</span>
                  <p className="text-text font-medium">
                    {order.contactAddress ?? "—"}
                  </p>
                </div>
              </div>
            </div>

            {/* Vehicle */}
            {vehicleStr && (
              <div className="bg-surface border border-border rounded-xl p-4">
                <h2 className="text-sm font-semibold text-text mb-2">
                  Vehicle
                </h2>
                <p className="text-sm text-text">{vehicleStr}</p>
              </div>
            )}

            {/* Line items */}
            <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-text">Services</h2>
              {items.length > 0 ? (
                <>
                  <div className="border border-border rounded-lg overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-surface-alt text-text-secondary">
                          <th className="text-left px-3 py-1.5 font-medium">
                            Item
                          </th>
                          <th className="text-right px-3 py-1.5 font-medium">
                            Qty
                          </th>
                          <th className="text-right px-3 py-1.5 font-medium">
                            Price
                          </th>
                          <th className="text-right px-3 py-1.5 font-medium">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item) => (
                          <tr key={item.id} className="border-t border-border">
                            <td className="px-3 py-1.5 text-text">
                              <span className="text-[10px] uppercase text-text-secondary mr-1.5">
                                {item.category}
                              </span>
                              {item.name}
                              {item.description && (
                                <p className="text-[10px] text-text-secondary mt-0.5">
                                  {item.description}
                                </p>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right text-text">
                              {item.quantity}
                            </td>
                            <td className="px-3 py-1.5 text-right text-text">
                              {formatCents(item.unitPriceCents)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-text font-medium">
                              {formatCents(item.totalCents)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-surface-alt">
                          <td
                            colSpan={3}
                            className="px-3 py-1.5 text-right font-medium text-text"
                          >
                            Subtotal
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold text-text">
                            {formatCents(order.subtotalCents ?? 0)}
                          </td>
                        </tr>
                        {(order.priceRangeLowCents != null ||
                          order.priceRangeHighCents != null) && (
                          <tr className="border-t border-border">
                            <td
                              colSpan={3}
                              className="px-3 py-1 text-right text-xs text-text-secondary"
                            >
                              Estimated range
                            </td>
                            <td className="px-3 py-1 text-right text-xs text-text-secondary">
                              {order.priceRangeLowCents != null
                                ? formatCents(order.priceRangeLowCents)
                                : "—"}{" "}
                              –{" "}
                              {order.priceRangeHighCents != null
                                ? formatCents(order.priceRangeHighCents)
                                : "—"}
                            </td>
                          </tr>
                        )}
                      </tfoot>
                    </table>
                  </div>
                  {order.notes && (
                    <p className="text-xs text-text-secondary italic">
                      {order.notes}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-text-secondary">
                  No service items yet — your estimate is being prepared.
                </p>
              )}
            </div>

            {/* Cancellation reason */}
            {order.cancellationReason && (
              <div className="bg-surface border border-red-200 dark:border-red-900/50 rounded-xl p-4">
                <h2 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-1">
                  Cancellation Reason
                </h2>
                <p className="text-xs text-text">{order.cancellationReason}</p>
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div className="space-y-4">
            {/* Action buttons */}
            {canApproveDecline && (
              <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
                <h2 className="text-sm font-semibold text-text">
                  Your Action Required
                </h2>
                <p className="text-xs text-text-secondary">
                  Please review the services above and approve or decline this
                  estimate.
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => handleAction("approve")}
                    disabled={actionLoading}
                    className="flex items-center justify-center gap-1.5 text-xs font-medium px-4 py-2.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve Estimate
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAction("decline")}
                    disabled={actionLoading}
                    className="flex items-center justify-center gap-1.5 text-xs font-medium px-4 py-2.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                    Decline
                  </button>
                </div>
              </div>
            )}

            {/* Order details */}
            <div className="bg-surface border border-border rounded-xl p-4 space-y-2">
              <h2 className="text-sm font-semibold text-text">Details</h2>
              <div className="text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Order ID</span>
                  <span className="text-text font-mono">#{order.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Status</span>
                  <span className="text-text">{portalStatus.label}</span>
                </div>
                {order.expiresAt && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">
                      Estimate expires
                    </span>
                    <span className="text-text">
                      <DateTime value={order.expiresAt} format="date" />
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-text-secondary">Updated</span>
                  <span className="text-text">
                    <DateTime value={order.updatedAt} format="datetime" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Activity timeline */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <h2 className="text-sm font-semibold text-text mb-3">
            Order History
          </h2>
          <StatusTimeline events={events ?? []} />
        </div>
      </div>
    </>
  );
}
