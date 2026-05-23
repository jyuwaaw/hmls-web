"use client";

import type { Order } from "@hmls/shared/db/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// NotesSection has a narrower contract than SectionProps because no
// STATUS_PROFILES.editableSections currently lists "notes" — it's always
// read-only. Keeps the call site honest.
type Props = { order: Order };

export function NotesSection({ order }: Props) {
  if (!order.adminNotes && !order.notes) return null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Notes</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-2">
        {order.adminNotes && (
          <div>
            <p className="text-muted-foreground">Admin notes</p>
            <p className="text-foreground whitespace-pre-wrap">
              {order.adminNotes}
            </p>
          </div>
        )}
        {order.notes && (
          <div>
            <p className="text-muted-foreground">Estimate notes</p>
            <p className="text-foreground whitespace-pre-wrap">{order.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
