"use client";

import type { Order } from "@hmls/shared/db/types";
import { hasBeenSentToCustomer } from "@hmls/shared/order/status";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { leadAction, type OrderInvoker } from "@/lib/order-actions";
import { ActionButton } from "./ActionButton";

type Props = {
  order: Order;
  invoker: OrderInvoker;
};

export function DraftBanner({ order, invoker }: Props) {
  const lead = leadAction(order);

  if (!lead) return null;

  // Draft dual-semantics: statusHistory containing `estimated` means this
  // draft is a pulled-back revision of an estimate the customer already saw
  // — never a fresh AI draft. Revision copy wins over the walk-in copy.
  const revising = hasBeenSentToCustomer(order);
  // Banner copy follows whichever action `leadAction` actually picked — not
  // a sibling action's predicate — so they can't drift apart later.
  const tentative = !revising && lead.id === "approve_walk_in";

  return (
    <Card className="border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 gap-0 py-0">
      <CardContent className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              {revising
                ? `Revision in progress · rev ${order.revisionNumber}`
                : tentative
                  ? "Tentative booking — pending your confirmation"
                  : "Pending shop review"}
            </p>
            <p className="text-amber-800 dark:text-amber-300/90 mt-0.5">
              {revising
                ? "This estimate was already sent to the customer and is being revised — it's withdrawn until you re-send it."
                : tentative
                  ? "Customer accepted the AI-drafted estimate and a time slot in chat. Review line items and pricing, then confirm to lock in the appointment."
                  : "AI drafted this estimate from the customer chat. Review line items and pricing, then send it to the customer."}
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <ActionButton
            action={lead}
            order={order}
            onClick={invoker.invoke}
            disabled={invoker.transitioning}
            prominent
            banner
          />
        </div>
      </CardContent>
    </Card>
  );
}
