"use client";

import type { OrderEvent, OrderItem } from "@hmls/shared/db/types";
import {
  EDITABLE_STATUSES,
  isOrderStatus,
  type OrderStatus,
} from "@hmls/shared/order/status";
import {
  ArrowLeft,
  ClipboardEdit,
  ExternalLink,
  FileText,
  MessageSquare,
  Pencil,
  Printer,
  Tag,
  User,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { OrderProgressBar } from "@/components/OrderProgressBar";
import { CustomerEditor } from "@/components/order/CustomerEditor";
import { DraftBanner } from "@/components/order/DraftBanner";
import { ItemEditor } from "@/components/order/ItemEditor";
import { OrderDetailsCard } from "@/components/order/OrderDetailsCard";
import { OrderOpsPanel } from "@/components/order/OrderOpsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { askReason } from "@/components/ui/ReasonDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminOrder } from "@/hooks/useAdmin";
import { useAdminMechanics } from "@/hooks/useAdminMechanics";
import {
  type OrderContactPatch,
  useOrderMutations,
} from "@/hooks/useOrderMutations";
import {
  getAdminOrdersListHref,
  parseAdminOrdersFilter,
  parseAdminOrdersSearch,
} from "@/lib/admin-order-filters";
import { AGENT_URL } from "@/lib/config";
import { formatCents } from "@/lib/format";
import {
  isTentativeBooking,
  ORDER_STEP_LABELS_ADMIN,
  statusDisplay,
} from "@/lib/status-display";
import { cn } from "@/lib/utils";

/* ── Constants ────────────────────────────────────────────────────────── */

// Panel-visibility predicates over canonical OrderStatus. These are NOT
// quote/booking *statuses* (those tables were dropped in Layer 3) — they
// just decide which side panel to render in the order detail view.
const SHOW_ESTIMATE_PANEL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "draft",
  "revised",
]);
const SHOW_QUOTE_PANEL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "estimated",
  "approved",
]);
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

/* ── PDF Preview Dialog ──────────────────────────────────────────────── */

function PdfPreviewDialog({
  open,
  onOpenChange,
  pdfUrl,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfUrl: string;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[90vh] p-0 gap-0">
        <DialogHeader className="px-4 py-2 border-b">
          <div className="flex items-center justify-between w-full">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const w = window.open(pdfUrl, "_blank");
                  if (w) w.addEventListener("load", () => w.print());
                }}
              >
                <Printer className="w-3 h-3" /> Print
              </Button>
              <Button variant="ghost" size="xs" asChild>
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3 h-3" /> Open
                </a>
              </Button>
            </div>
          </div>
        </DialogHeader>
        <iframe src={pdfUrl} className="w-full flex-1" title={title} />
      </DialogContent>
    </Dialog>
  );
}

/* ── Estimate Panel ───────────────────────────────────────────────────── */

function EstimatePanel({
  order,
}: {
  order: {
    shareToken: string | null;
    id: number;
    vehicleInfo: { year?: string; make?: string; model?: string } | null;
    priceRangeLowCents: number | null;
    priceRangeHighCents: number | null;
    expiresAt: string | null;
  };
}) {
  const vehicle = order.vehicleInfo;
  const [showPdf, setShowPdf] = useState(false);
  const pdfUrl = order.shareToken
    ? `${AGENT_URL}/api/orders/${order.id}/pdf?token=${order.shareToken}`
    : null;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-3 py-3">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide">
            Estimate
          </CardTitle>
          {pdfUrl && (
            <CardAction>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowPdf(true)}
                >
                  <FileText className="w-3 h-3" /> Preview
                </Button>
                <Button variant="ghost" size="xs" asChild>
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </Button>
              </div>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-1.5">
          {vehicle && (
            <p className="text-xs text-muted-foreground">
              {[vehicle.year, vehicle.make, vehicle.model]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
          {(order.priceRangeLowCents != null ||
            order.priceRangeHighCents != null) && (
            <p className="text-xs text-foreground">
              Range:{" "}
              <span className="font-medium">
                {order.priceRangeLowCents != null
                  ? formatCents(order.priceRangeLowCents)
                  : "—"}
                {" – "}
                {order.priceRangeHighCents != null
                  ? formatCents(order.priceRangeHighCents)
                  : "—"}
              </span>
            </p>
          )}
          {order.expiresAt && (
            <p className="text-xs text-muted-foreground">
              Expires <DateTime value={order.expiresAt} format="date" />
            </p>
          )}
        </CardContent>
      </Card>

      {pdfUrl && (
        <PdfPreviewDialog
          open={showPdf}
          onOpenChange={setShowPdf}
          pdfUrl={pdfUrl}
          title={`Estimate PDF — Order #${order.id}`}
        />
      )}
    </>
  );
}

/* ── Quote Panel ──────────────────────────────────────────────────────── */

function QuotePanel({
  order,
}: {
  order: {
    id: number;
    shareToken: string | null;
    subtotalCents: number;
  };
}) {
  const [showPdf, setShowPdf] = useState(false);
  const pdfUrl = order.shareToken
    ? `${AGENT_URL}/api/orders/${order.id}/pdf?token=${order.shareToken}`
    : null;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-3 py-3">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide">
            Quote
          </CardTitle>
          {pdfUrl && (
            <CardAction>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowPdf(true)}
                >
                  <FileText className="w-3 h-3" /> Preview
                </Button>
                <Button variant="ghost" size="xs" asChild>
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </Button>
              </div>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-1.5">
          <p className="text-xs text-foreground">
            Total:{" "}
            <span className="font-semibold">
              {formatCents(order.subtotalCents ?? 0)}
            </span>
          </p>
        </CardContent>
      </Card>

      {pdfUrl && (
        <PdfPreviewDialog
          open={showPdf}
          onOpenChange={setShowPdf}
          pdfUrl={pdfUrl}
          title={`Quote PDF — Order #${order.id}`}
        />
      )}
    </>
  );
}

/* ── Activity Timeline ────────────────────────────────────────────────── */

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function eventDescription(event: OrderEvent): string {
  switch (event.eventType) {
    case "status_change":
      if (event.fromStatus && event.toStatus) {
        const fromLabel = isOrderStatus(event.fromStatus)
          ? ORDER_STEP_LABELS_ADMIN[event.fromStatus]
          : event.fromStatus;
        const toLabel = isOrderStatus(event.toStatus)
          ? ORDER_STEP_LABELS_ADMIN[event.toStatus]
          : event.toStatus;
        return `Status changed from ${fromLabel} → ${toLabel}`;
      }
      return "Status changed";
    case "items_edited":
      return "Line items updated";
    case "contact_edited":
      return "Contact info updated";
    case "note_added": {
      const note = (event.metadata as { note?: string })?.note;
      return note ? `Note: ${note}` : "Note added";
    }
    default:
      return event.eventType.replace(/_/g, " ");
  }
}

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType === "status_change") {
    return (
      <div className="w-6 h-6 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
        <Tag className="w-3 h-3 text-emerald-500" />
      </div>
    );
  }
  if (eventType === "items_edited") {
    return (
      <div className="w-6 h-6 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0">
        <ClipboardEdit className="w-3 h-3 text-blue-400" />
      </div>
    );
  }
  if (eventType === "contact_edited") {
    return (
      <div className="w-6 h-6 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
        <User className="w-3 h-3 text-purple-400" />
      </div>
    );
  }
  if (eventType === "note_added") {
    return (
      <div className="w-6 h-6 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center shrink-0">
        <MessageSquare className="w-3 h-3 text-yellow-400" />
      </div>
    );
  }
  return (
    <div className="w-6 h-6 rounded-full bg-muted border border-border flex items-center justify-center shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
    </div>
  );
}

function ActivityTimeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">
        No activity recorded yet.
      </p>
    );
  }
  return (
    <div className="space-y-0">
      {events.map((event, idx) => (
        <div key={event.id} className="flex gap-3">
          {/* Timeline line + icon */}
          <div className="flex flex-col items-center">
            <EventIcon eventType={event.eventType} />
            {idx < events.length - 1 && (
              <div className="w-px flex-1 bg-border mt-1 mb-1" />
            )}
          </div>
          {/* Content */}
          <div className="pb-3 min-w-0 flex-1">
            <p className="text-xs text-foreground leading-snug">
              {eventDescription(event)}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">
                {event.actor}
              </span>
              <span className="text-[10px] text-muted-foreground">·</span>
              <span className="text-[10px] text-muted-foreground">
                {event.createdAt ? relativeTime(event.createdAt) : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
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

  const [editMode, setEditMode] = useState<null | "items" | "customer">(null);
  const { mechanics } = useAdminMechanics();
  const { saveItems, saveCustomer, savingItems, savingCustomer } =
    useOrderMutations(orderId, mutate);

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
  const items: OrderItem[] = order.items ?? [];
  const vehicle = order.vehicleInfo;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
    : null;
  const knownStatus = isOrderStatus(order.status) ? order.status : undefined;
  const isEditable = knownStatus ? EDITABLE_STATUSES.has(knownStatus) : false;
  const tentative = isTentativeBooking(order);
  const adminStatus = statusDisplay(order.status, "admin", {
    tentativeBooking: tentative,
  });

  const showEstimatePanel = knownStatus
    ? SHOW_ESTIMATE_PANEL_STATUSES.has(knownStatus)
    : false;
  const showQuotePanel = knownStatus
    ? SHOW_QUOTE_PANEL_STATUSES.has(knownStatus)
    : false;
  const bookingProviderName =
    order.providerId != null
      ? (mechanics.find((m) => m.id === order.providerId)?.name ?? null)
      : null;

  async function handleSaveItems(newItems: OrderItem[], newNotes: string) {
    try {
      await saveItems(newItems, newNotes);
      setEditMode(null);
    } catch {
      /* error toast shown by hook */
    }
  }

  async function handleSaveCustomer(patch: OrderContactPatch) {
    try {
      await saveCustomer(patch);
      setEditMode(null);
    } catch {
      /* error toast shown by hook */
    }
  }

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
          {order.revisionNumber > 1 && (
            <Badge variant="secondary" className="text-[10px]">
              v{order.revisionNumber}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Created <DateTime value={order.createdAt} format="datetime" />
        </span>
      </div>

      {order.status === "draft" && (
        <DraftBanner order={order} revalidate={mutate} askReason={askReason} />
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
        {/* Left: main details */}
        <div className="lg:col-span-2 space-y-4">
          {/* Customer info */}
          <Card className="gap-0 py-0">
            <CardHeader className="px-4 py-4">
              <CardTitle className="text-sm">Contact</CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    setEditMode(editMode === "customer" ? null : "customer")
                  }
                >
                  <User className="w-3.5 h-3.5" />
                  Edit
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {editMode === "customer" ? (
                <CustomerEditor
                  order={order}
                  saving={savingCustomer}
                  onCancel={() => setEditMode(null)}
                  onSave={handleSaveCustomer}
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Name</span>
                    <p className="text-foreground font-medium">
                      {order.contactName ?? "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Email</span>
                    <p className="text-foreground font-medium">
                      {order.contactEmail ?? "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Phone</span>
                    <p className="text-foreground font-medium">
                      {order.contactPhone ?? "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Address</span>
                    <p className="text-foreground font-medium">
                      {order.contactAddress ?? "—"}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Vehicle */}
          {vehicleStr && (
            <Card className="gap-0 py-0">
              <CardHeader className="px-4 py-4">
                <CardTitle className="text-sm">Vehicle</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-xs text-foreground">{vehicleStr}</p>
              </CardContent>
            </Card>
          )}

          {/* Items table */}
          <Card className="gap-0 py-0">
            <CardHeader className="px-4 py-4">
              <CardTitle className="text-sm">Line Items</CardTitle>
              {isEditable && editMode !== "items" && (
                <CardAction>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEditMode("items")}
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              {editMode === "items" && isEditable ? (
                <ItemEditor
                  items={items}
                  notes={order.notes}
                  saving={savingItems}
                  onCancel={() => setEditMode(null)}
                  onSave={handleSaveItems}
                />
              ) : items.length > 0 ? (
                <>
                  <div className="border border-border rounded-lg overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted text-muted-foreground">
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
                            <td className="px-3 py-1.5 text-foreground">
                              <span className="text-[10px] uppercase text-muted-foreground mr-1.5">
                                {item.category}
                              </span>
                              {item.name}
                            </td>
                            <td className="px-3 py-1.5 text-right text-foreground">
                              {item.quantity}
                            </td>
                            <td className="px-3 py-1.5 text-right text-foreground">
                              {formatCents(item.unitPriceCents)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-foreground font-medium">
                              {formatCents(item.totalCents)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-muted">
                          <td
                            colSpan={3}
                            className="px-3 py-1.5 text-right font-medium text-foreground"
                          >
                            Subtotal
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold text-foreground">
                            {formatCents(order.subtotalCents ?? 0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {order.notes && (
                    <p className="text-xs text-muted-foreground italic">
                      {order.notes}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No items yet.</p>
              )}
            </CardContent>
          </Card>

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
          {/* Status-contextual estimate/quote PDF panels still live here for
              now — Phase 4 moves them into the main column. */}
          {showEstimatePanel && <EstimatePanel order={order} />}
          {showQuotePanel && <QuotePanel order={order} />}

          <OrderOpsPanel
            order={order}
            revalidate={mutate}
            askReason={askReason}
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
