"use client";

import type { Order } from "@hmls/shared/db/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";

type Props = {
  order: Order;
  /** Mechanic display name, looked up by caller (mechanics list lives in the
   *  parent page). */
  mechanicName?: string | null;
};

export function OrderDetailsCard({ order, mechanicName }: Props) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Details</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Order ID</span>
            <span className="text-foreground font-mono">#{order.id}</span>
          </div>
          {order.providerId != null && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Mechanic</span>
              <span className="text-foreground">
                {mechanicName ?? `#${order.providerId}`}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Updated</span>
            <span className="text-foreground">
              <DateTime value={order.updatedAt} format="datetime" />
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
