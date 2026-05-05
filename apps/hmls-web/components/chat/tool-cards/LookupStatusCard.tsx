"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/** Tools that resolve in <100ms would otherwise flash a spinner for one
 * frame and immediately swap to the checkmark — visual noise. Hold the
 * running state at least this long so the transition feels intentional. */
const MIN_RUNNING_MS = 200;

/** Friendly customer-facing labels for backstage tool calls. Whitelist —
 * any tool not listed here renders nothing in customer chat (silence is
 * safer than leaking raw tool I/O, which carries pre-markup costs). */
export const CUSTOMER_LOOKUP_LABELS: Record<
  string,
  { running: string; done: string }
> = {
  lookup_labor_time: {
    running: "Checking labor reference",
    done: "Checked labor reference",
  },
  lookup_parts_price: {
    running: "Checking parts pricing",
    done: "Checked parts pricing",
  },
  get_order_status: {
    running: "Looking up your service history",
    done: "Checked your service history",
  },
  schedule_order: {
    // Neutral wording — `schedule_order` from a chat-flow draft only
    // tentatively books the slot (the order stays in `draft` until shop
    // review). "Appointment confirmed" was misleading; the actual
    // confirmation copy lives in the agent's text response, which
    // distinguishes tentative vs. locked-in based on the tool's
    // `pendingShopReview` flag.
    running: "Sending your booking",
    done: "Booking sent to shop",
  },
  list_vehicle_services: {
    running: "Listing services",
    done: "Listed services",
  },
  cancel_order: {
    running: "Canceling order",
    done: "Order canceled",
  },
};

/** Single-line, non-expandable status pill for backstage lookups. Never
 * renders raw input/output — only the friendly label + a state icon. Used in
 * customer chat to indicate progress without leaking internal cost data. */
export function LookupStatusCard({
  toolName,
  state,
}: {
  toolName: string;
  state: string;
}) {
  const labels = CUSTOMER_LOOKUP_LABELS[toolName];
  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";

  // Hold "running" visible for MIN_RUNNING_MS even if the tool resolves
  // immediately — keeps fast lookups from flashing.
  const [holdRunning, setHoldRunning] = useState(true);
  useEffect(() => {
    if (isDone) {
      const timer = window.setTimeout(
        () => setHoldRunning(false),
        MIN_RUNNING_MS,
      );
      return () => window.clearTimeout(timer);
    }
    setHoldRunning(true);
  }, [isDone]);

  if (!labels) return null;
  if (!isRunning && !isDone) return null;

  const showRunning = isRunning || holdRunning;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-alt px-3 py-1 text-xs text-text-secondary">
      {showRunning ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-red-primary" />
      ) : (
        <Check className="w-3.5 h-3.5 text-emerald-500" />
      )}
      <span>{showRunning ? `${labels.running}…` : labels.done}</span>
    </div>
  );
}
