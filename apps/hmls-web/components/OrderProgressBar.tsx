import {
  getOrderStepState,
  isOrderStatus,
  ORDER_BRANCH_STATUSES,
  ORDER_MAIN_STEPS,
  ORDER_TERMINAL_STATUSES,
} from "@hmls/shared/order/status";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  ORDER_STEP_LABELS_ADMIN,
  ORDER_STEP_LABELS_PORTAL,
  statusDisplay,
} from "@/lib/status-display";
import { cn } from "@/lib/utils";

type Variant = "admin" | "portal";

type VariantStyles = {
  labels: Record<string, string>;
  connectorWidth: string;
  paddingBottom: string;
  currentCircle: string;
  pendingCircle: string;
  currentLabel: string;
  pendingLabel: string;
  messageText: string;
  branchMessages: Record<string, string>;
  tentativeMessage: string;
  renderBadge: (status: string, tentative?: boolean) => ReactNode;
};

const ADMIN_STYLES: VariantStyles = {
  labels: ORDER_STEP_LABELS_ADMIN,
  connectorWidth: "w-4 sm:w-8",
  paddingBottom: "pb-2",
  currentCircle: "bg-primary text-primary-foreground ring-2 ring-primary/30",
  pendingCircle: "bg-card border-2 border-border text-muted-foreground",
  currentLabel: "font-semibold text-foreground",
  pendingLabel: "text-muted-foreground",
  messageText: "text-muted-foreground",
  branchMessages: {
    declined: "Customer declined — revise or cancel",
    revised: "Revised estimate ready to re-send",
    cancelled: "Order was cancelled",
  },
  tentativeMessage: "Customer accepted in chat — awaiting your confirmation",
  renderBadge: (status, tentative) => {
    const entry = statusDisplay(status, "admin", {
      tentativeBooking: tentative,
    });
    return (
      <Badge variant="outline" className={cn("border-0", entry.color)}>
        {entry.label}
      </Badge>
    );
  },
};

const PORTAL_STYLES: VariantStyles = {
  labels: ORDER_STEP_LABELS_PORTAL,
  connectorWidth: "w-3 sm:w-6",
  paddingBottom: "pb-1",
  currentCircle: "bg-red-primary text-white ring-2 ring-red-primary/30",
  pendingCircle: "bg-surface border-2 border-border text-text-secondary",
  currentLabel: "font-semibold text-text",
  pendingLabel: "text-text-secondary",
  messageText: "text-text-secondary",
  branchMessages: {
    declined: "Estimate declined — we may send a revised version soon",
    revised: "Updated estimate ready for your review",
    cancelled: "Order was cancelled",
  },
  tentativeMessage:
    "Tentatively scheduled — the shop is reviewing the estimate and will lock in your appointment shortly",
  renderBadge: (status, tentative) => (
    <StatusBadge
      entry={statusDisplay(status, "portal", { tentativeBooking: tentative })}
    />
  ),
};

const STYLES: Record<Variant, VariantStyles> = {
  admin: ADMIN_STYLES,
  portal: PORTAL_STYLES,
};

export function OrderProgressBar({
  status,
  variant,
  tentativeBooking = false,
}: {
  status: string;
  variant: Variant;
  /** Set when a draft has accumulated chat-flow scheduling but the shop
   *  hasn't approved yet. The bar shows the linear steps as pending and
   *  surfaces a "Pending Confirmation" badge so the UX matches reality. */
  tentativeBooking?: boolean;
}) {
  const styles = STYLES[variant];
  const knownStatus = isOrderStatus(status) ? status : ("draft" as const);
  const isTerminal = ORDER_TERMINAL_STATUSES.has(knownStatus);
  const isBranch = ORDER_BRANCH_STATUSES.has(knownStatus);
  const showTentative = tentativeBooking && knownStatus === "draft";
  const message = showTentative
    ? styles.tentativeMessage
    : styles.branchMessages[status];

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex items-center gap-0 overflow-x-auto",
          styles.paddingBottom,
        )}
      >
        {ORDER_MAIN_STEPS.map((step, idx) => {
          const state = getOrderStepState(step, knownStatus);
          const isDone = state === "completed" || state === "current";
          return (
            <div key={step} className="flex items-center">
              {idx > 0 && (
                <div
                  className={cn(
                    "h-0.5 shrink-0",
                    styles.connectorWidth,
                    isDone ? "bg-emerald-500" : "bg-border",
                  )}
                />
              )}
              <div className="flex flex-col items-center gap-1 shrink-0">
                <div
                  className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors",
                    state === "completed"
                      ? "bg-emerald-500 text-white"
                      : state === "current"
                        ? styles.currentCircle
                        : styles.pendingCircle,
                  )}
                >
                  {state === "completed" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <span className="text-[10px]">{idx + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "text-[10px] leading-tight text-center whitespace-nowrap",
                    state === "current"
                      ? styles.currentLabel
                      : state === "completed"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : styles.pendingLabel,
                  )}
                >
                  {styles.labels[step]}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {(isTerminal || isBranch || showTentative) && (
        <div className="flex items-center gap-2">
          {styles.renderBadge(status, showTentative)}
          {message && (
            <span className={cn("text-xs", styles.messageText)}>{message}</span>
          )}
        </div>
      )}
    </div>
  );
}
