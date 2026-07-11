"use client";

import type { ContactMethod } from "@hmls/shared/api/contracts/orders";
import type { Order } from "@hmls/shared/db/types";
import {
  type EditableSection,
  STATUS_PROFILES,
} from "@hmls/shared/order/profiles";
import { canonicalStatus } from "@/lib/status-display";
import { CustomerSection } from "./sections/CustomerSection";
import { DiagnosisSection } from "./sections/DiagnosisSection";
import { ItemsSection } from "./sections/ItemsSection";
import { NotesSection } from "./sections/NotesSection";
import { ScheduleSection } from "./sections/ScheduleSection";

type Props = {
  order: Order;
  revalidate(): void;
  /** Forwarded from the page so ScheduleSection can request the same dialogs OrderOpsPanel mounts. */
  onSetTime(): void;
  onReassign(): void;
  /** Customer profile default for the Prefers badge fallback. */
  profilePreferred?: ContactMethod | null;
};

export function OrderSectionsRegion({
  order,
  revalidate,
  onSetTime,
  onReassign,
  profilePreferred,
}: Props) {
  const status = canonicalStatus(order.status);
  const profile = status ? STATUS_PROFILES[status] : null;
  const can = (s: EditableSection) =>
    profile?.editableSections.includes(s) ?? false;
  return (
    <div className="space-y-4">
      <ItemsSection
        order={order}
        readOnly={!can("items")}
        revalidate={revalidate}
      />
      <CustomerSection
        order={order}
        readOnly={!can("customer")}
        revalidate={revalidate}
        profilePreferred={profilePreferred}
      />
      <ScheduleSection
        order={order}
        readOnly={!can("schedule")}
        revalidate={revalidate}
        onSetTime={onSetTime}
        onReassign={onReassign}
      />
      <DiagnosisSection
        order={order}
        readOnly={!can("diagnosis")}
        revalidate={revalidate}
      />
      <NotesSection order={order} />
    </div>
  );
}
