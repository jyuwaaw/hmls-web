"use client";

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

export function EstimatePanel({
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
