import type { ContactMethod } from "@hmls/shared/api/contracts/orders";
import type { Order, OrderItem } from "@hmls/shared/db/types";
import type { OrderAuthorization } from "@hmls/shared/order/status";
import { useState } from "react";
import { toast } from "sonner";
import { useApi } from "@/hooks/useApi";
import { adminPaths } from "@/lib/api-paths";

export type OrderContactPatch = {
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  contact_address: string;
  contact_preferred: ContactMethod | null;
};

/** Mirrors scheduleOrderInput schema from @hmls/shared/api/contracts/orders */
type ScheduleBody = {
  scheduledAt: string;
  durationMinutes: number;
  location?: string | null;
};

export function useOrderMutations(
  orderId: number | string,
  revalidate: () => void,
) {
  const api = useApi();
  const id = String(orderId);

  const [transitioning, setTransitioning] = useState(false);
  const [savingItems, setSavingItems] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [loggingContact, setLoggingContact] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingDiagnosis, setSavingDiagnosis] = useState(false);

  async function transitionStatus(
    newStatus: string,
    cancellationReason?: string,
    /** Customer-authorization evidence — required by the API on any
     *  →approved edge (including the draft→approved walk-in shortcut). */
    authorization?: OrderAuthorization,
  ): Promise<void> {
    setTransitioning(true);
    try {
      const body = { status: newStatus, cancellationReason, authorization };
      await api.patch<Order>(adminPaths.orderStatus(id), body);
      revalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update status");
      throw e;
    } finally {
      setTransitioning(false);
    }
  }

  async function saveItems(items: OrderItem[], notes: string): Promise<void> {
    setSavingItems(true);
    try {
      await api.patch<Order>(adminPaths.order(id), { items, notes });
      revalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save items");
      throw e;
    } finally {
      setSavingItems(false);
    }
  }

  async function saveCustomer(patch: OrderContactPatch): Promise<void> {
    setSavingCustomer(true);
    try {
      await api.patch<Order>(adminPaths.order(id), patch);
      revalidate();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to save contact info",
      );
      throw e;
    } finally {
      setSavingCustomer(false);
    }
  }

  async function logContact(method: ContactMethod): Promise<void> {
    setLoggingContact(true);
    try {
      await api.post(adminPaths.orderContactLog(id), { method });
      toast.success(`Logged: contacted by ${method}`);
      revalidate();
    } catch (e) {
      // No rethrow: the only caller is a fire-and-forget onClick — the toast
      // IS the error contract; rethrowing would just be an unhandled rejection.
      toast.error(e instanceof Error ? e.message : "Failed to log contact");
    } finally {
      setLoggingContact(false);
    }
  }

  async function setSchedule(
    scheduledAt: string,
    durationMinutes: number,
    location?: string | null,
  ): Promise<void> {
    setSavingSchedule(true);
    try {
      const body: ScheduleBody = { scheduledAt, durationMinutes };
      if (location !== undefined) body.location = location;
      await api.post<Order>(adminPaths.orderSchedule(id), body);
      revalidate();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to set appointment time",
      );
      throw e;
    } finally {
      setSavingSchedule(false);
    }
  }

  async function markPaid(args: {
    amountCents: number;
    method: string;
    reference?: string;
    paidAt?: string;
  }): Promise<void> {
    setSavingPayment(true);
    try {
      await api.post<Order>(adminPaths.orderPayment(id), args);
      revalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to record payment");
      throw e;
    } finally {
      setSavingPayment(false);
    }
  }

  /** Records the mechanic's confirmed diagnosis — the ground-truth half of the
   *  (symptom → confirmed) loop. Writes via the generic order PATCH. */
  async function saveConfirmedDiagnosis(
    confirmedDiagnosis: string,
  ): Promise<void> {
    setSavingDiagnosis(true);
    try {
      await api.patch<Order>(adminPaths.order(id), { confirmedDiagnosis });
      revalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save diagnosis");
      throw e;
    } finally {
      setSavingDiagnosis(false);
    }
  }

  return {
    transitionStatus,
    saveItems,
    saveCustomer,
    logContact,
    setSchedule,
    markPaid,
    saveConfirmedDiagnosis,
    transitioning,
    savingItems,
    savingCustomer,
    loggingContact,
    savingSchedule,
    savingPayment,
    savingDiagnosis,
  };
}
