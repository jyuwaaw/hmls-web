"use client";

import type { Order } from "@hmls/shared/db/types";
import { ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { AGENT_URL } from "@/lib/config";
import { formatCents } from "@/lib/format";
import { PdfPreviewDialog } from "./PdfPreviewDialog";

/**
 * Unified Estimate/Quote document card. Always visible — admin needs the
 * shareable PDF link regardless of order status, for audit.
 *
 * Two distinct PDF paths:
 *   - With shareToken: public token-based route `/api/orders/:id/pdf?token=...`
 *     (also the link sent in customer emails — no auth required, token = capability)
 *   - Without shareToken: admin-authenticated route `/api/admin/orders/:id/pdf`
 *     (requires admin session + shop scope; no token needed; for draft/preview use)
 *
 * Note: the public route now requires the token — id-only access was an IDOR.
 */
export function OrderDocumentCard({ order }: { order: Order }) {
  const [showPdf, setShowPdf] = useState(false);
  const pdfUrl = order.shareToken
    ? `${AGENT_URL}/api/orders/${order.id}/pdf?token=${order.shareToken}`
    : `${AGENT_URL}/api/admin/orders/${order.id}/pdf`;
  const vehicle = order.vehicleInfo;
  const hasRange =
    order.priceRangeLowCents != null || order.priceRangeHighCents != null;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-3 py-3">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide">
            Estimate
          </CardTitle>
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
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-1.5 text-xs">
          {vehicle && (
            <p className="text-muted-foreground">
              {[vehicle.year, vehicle.make, vehicle.model]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
          <p className="text-foreground">
            Total:{" "}
            <span className="font-semibold">
              {formatCents(order.subtotalCents ?? 0)}
            </span>
          </p>
          {hasRange && (
            <p className="text-muted-foreground">
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
            <p className="text-muted-foreground">
              Expires <DateTime value={order.expiresAt} format="date" />
            </p>
          )}
          {!order.shareToken && (
            <p className="text-muted-foreground italic">
              No share link yet — customer-facing copy generates on send.
            </p>
          )}
        </CardContent>
      </Card>
      <PdfPreviewDialog
        open={showPdf}
        onOpenChange={setShowPdf}
        pdfUrl={pdfUrl}
        title={`Order #${order.id} — Document`}
      />
    </>
  );
}
