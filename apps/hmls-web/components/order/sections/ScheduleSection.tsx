"use client";

import { Calendar, MapPin, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import { useAdminMechanics } from "@/hooks/useAdminMechanics";
import type { SectionProps } from "./types";

type Props = SectionProps & {
  /** Open the set-time dialog from the parent (OrderOpsPanel mounts it). */
  onSetTime(): void;
  /** Open the reassign dialog from the parent. */
  onReassign(): void;
};

export function ScheduleSection({
  order,
  readOnly,
  onSetTime,
  onReassign,
}: Props) {
  const { mechanics } = useAdminMechanics();
  const mechanic =
    order.providerId != null
      ? mechanics.find((m) => m.id === order.providerId)
      : null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardTitle className="text-sm">Appointment</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          {order.scheduledAt ? (
            <DateTime value={order.scheduledAt} format="datetime" />
          ) : (
            <span className="text-muted-foreground">No time set</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
          {mechanic?.name ?? (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </div>
        {order.location && (
          <div className="flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-foreground">{order.location}</span>
          </div>
        )}
        {!readOnly && (
          <div className="flex gap-2 pt-2">
            <Button variant="ghost" size="xs" onClick={onSetTime}>
              {order.scheduledAt ? "Reschedule" : "Set time"}
            </Button>
            <Button variant="ghost" size="xs" onClick={onReassign}>
              {order.providerId != null ? "Reassign" : "Assign mechanic"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
