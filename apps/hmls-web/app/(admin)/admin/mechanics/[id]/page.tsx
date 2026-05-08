"use client";

import { isOrderStatus } from "@hmls/shared/order/status";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { AddTimeOffDialog } from "@/components/admin/mechanics/AddTimeOffDialog";
import { EditHoursDialog } from "@/components/admin/mechanics/EditHoursDialog";
import { EditProfileForm } from "@/components/admin/mechanics/EditProfileForm";
import { ReassignBookingDialog } from "@/components/admin/mechanics/ReassignBookingDialog";
import { ScheduleStrip } from "@/components/admin/mechanics/ScheduleStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type MechanicOrderRow,
  useAdminMechanic,
  useAdminMechanicAvailability,
  useAdminMechanicOrders,
  useAdminMechanicOverrides,
  useAdminMechanics,
} from "@/hooks/useAdminMechanics";
import { formatCents, formatDateTime } from "@/lib/format";
import { ORDER_STATUS } from "@/lib/status-display";
import { cn } from "@/lib/utils";

function ProfileCard({ id }: { id: number }) {
  const { mechanic, updateMechanic, deactivate } = useAdminMechanic(id);
  const [editing, setEditing] = useState(false);

  if (!mechanic) return <Skeleton className="h-40 w-full" />;

  return (
    <Card className="p-4 gap-0">
      <CardContent className="p-0 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Profile</h2>
          {!editing && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              {mechanic.isActive ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deactivate()}
                >
                  Deactivate
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateMechanic({ isActive: true })}
                >
                  Reactivate
                </Button>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <EditProfileForm
            mechanic={mechanic}
            onCancel={() => setEditing(false)}
            onSave={async (patch) => {
              await updateMechanic(patch);
              setEditing(false);
            }}
          />
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="text-foreground">{mechanic.email ?? "—"}</dd>
            <dt className="text-muted-foreground">Phone</dt>
            <dd className="text-foreground">{mechanic.phone ?? "—"}</dd>
            <dt className="text-muted-foreground">Timezone</dt>
            <dd className="text-foreground">{mechanic.timezone}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function BookingRow({
  b,
  onReassign,
}: {
  b: MechanicOrderRow;
  onReassign: (b: MechanicOrderRow) => void;
}) {
  const statusCfg = isOrderStatus(b.status)
    ? ORDER_STATUS[b.status]
    : {
        label: b.status,
        color: "bg-neutral-100 text-neutral-500",
      };
  const vehicle = b.vehicleInfo;
  const vehicleStr = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
    : null;
  return (
    <div className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">
            {b.scheduledAt ? formatDateTime(b.scheduledAt) : "Unscheduled"}
          </p>
          <Badge className={cn("border-transparent", statusCfg.color)}>
            {statusCfg.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          Order #{b.id}
          {vehicleStr ? ` · ${vehicleStr}` : ""} ·{" "}
          {b.customer.name ?? b.contactName ?? "Customer"}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Order actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onReassign(b)}>
            Reassign…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/orders/${b.id}`}>Open order</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4 gap-0">
      <CardContent className="p-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-display font-bold text-foreground tabular-nums">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export default function MechanicDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idStr } = use(params);
  const id = Number(idStr);
  const { mechanic, isLoading } = useAdminMechanic(id);
  // Pull a full year back so "Jobs completed" and "Recent completed" surface
  // historical data, not just the last 7 days. Server caps at 200 rows.
  // Stabilize the date strings — recomputing them on every render with
  // `new Date(Date.now()).toISOString()` produced a fresh value each tick,
  // which changed the SWR key, which triggered a refetch, which triggered
  // a re-render, which… you get it. useMemo pins the values per mount so
  // the SWR key is stable.
  const ordersFrom = useMemo(
    () => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    [],
  );
  const overridesFrom = useMemo(
    () => new Date().toISOString().slice(0, 10),
    [],
  );
  const overridesTo = useMemo(
    () =>
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    [],
  );

  const { orders: mechanicOrders, mutate: mutateMechanicOrders } =
    useAdminMechanicOrders(id, ordersFrom);
  const { availability } = useAdminMechanicAvailability(id);
  const { overrides, mutate: mutateOverrides } = useAdminMechanicOverrides(
    id,
    overridesFrom,
    overridesTo,
  );
  const { mechanics } = useAdminMechanics();
  const listRow = mechanics.find((m) => m.id === id);
  const jobsCompleted = mechanicOrders.filter(
    (b) => b.status === "completed",
  ).length;

  const [reassignTarget, setReassignTarget] = useState<MechanicOrderRow | null>(
    null,
  );
  const [editHoursOpen, setEditHoursOpen] = useState(false);
  const [timeOffOpen, setTimeOffOpen] = useState(false);

  if (isLoading || !mechanic) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  const nowMs = Date.now();
  const upcoming = mechanicOrders.filter(
    (b) => b.scheduledAt && new Date(b.scheduledAt).getTime() >= nowMs,
  );
  const recentCompleted = mechanicOrders
    .filter((b) => b.status === "completed")
    .slice(-10)
    .reverse();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/mechanics"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="text-2xl font-display font-bold text-foreground">
          {mechanic.name}
        </h1>
        <span
          role="status"
          aria-label={mechanic.isActive ? "Active" : "Inactive"}
          className={cn(
            "size-2 rounded-full",
            mechanic.isActive ? "bg-green-500" : "bg-neutral-400",
          )}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile
          label="Week utilization"
          value={
            listRow?.weekUtilization == null
              ? "—"
              : `${listRow.weekUtilization}%`
          }
        />
        <KpiTile
          label="Bookings this week"
          value={String(listRow?.upcomingBookingsCount ?? 0)}
        />
        <KpiTile
          label="Earnings (30d)"
          value={formatCents(listRow?.earnings30d ?? 0)}
        />
        <KpiTile label="Jobs completed" value={String(jobsCompleted)} />
      </div>

      <ProfileCard id={id} />

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-foreground">Next 7 days</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditHoursOpen(true)}
            >
              Edit hours
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTimeOffOpen(true)}
            >
              Add time off
            </Button>
          </div>
        </div>
        <Card className="p-3">
          <CardContent className="p-0">
            <ScheduleStrip
              weekly={availability}
              overrides={overrides}
              bookings={mechanicOrders}
            />
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-foreground mb-2">
          Upcoming bookings
        </h2>
        <Card className="p-0">
          <CardContent className="p-0">
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">
                No upcoming bookings.
              </p>
            ) : (
              upcoming
                .slice(0, 20)
                .map((b) => (
                  <BookingRow key={b.id} b={b} onReassign={setReassignTarget} />
                ))
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-foreground mb-2">
          Recent completed
        </h2>
        <Card className="p-0">
          <CardContent className="p-0">
            {recentCompleted.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">
                No completed jobs yet.
              </p>
            ) : (
              recentCompleted.map((b) => (
                <BookingRow key={b.id} b={b} onReassign={setReassignTarget} />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <EditHoursDialog
        mechanicId={id}
        open={editHoursOpen}
        onOpenChange={setEditHoursOpen}
      />
      <AddTimeOffDialog
        mechanicId={id}
        open={timeOffOpen}
        onOpenChange={setTimeOffOpen}
        onSaved={async () => {
          await mutateOverrides();
        }}
      />
      <ReassignBookingDialog
        order={reassignTarget}
        open={!!reassignTarget}
        onOpenChange={(o) => !o && setReassignTarget(null)}
        onAssigned={() => {
          mutateMechanicOrders();
          setReassignTarget(null);
        }}
      />
    </div>
  );
}
