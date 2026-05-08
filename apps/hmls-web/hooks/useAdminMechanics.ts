import type { Order } from "@hmls/shared/db/types";
import useSWR from "swr";
import { useApi } from "@/hooks/useApi";
import { adminPaths } from "@/lib/api-paths";
import { useStableArray } from "@/lib/swr-stable";

// ---------------------------------------------------------------------------
// Shape types (mirrors gateway admin-mechanics.ts local types)
// ---------------------------------------------------------------------------

export interface Mechanic {
  id: number;
  authUserId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  timezone: string;
  createdAt: string;
}

/** Mechanic + aggregate stats returned by GET /api/admin/mechanics */
export interface MechanicListRow extends Mechanic {
  weekUtilization: number | null;
  isOnJobNow: boolean;
  upcomingBookingsCount: number;
  earnings30d: number;
  nextBookingAt: string | null;
}

export interface WeeklyRow {
  id: number;
  providerId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ScheduleOverride {
  id: number;
  providerId: number;
  overrideDate: string;
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export type MechanicOrderRow = Order & {
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useAdminMechanics() {
  const api = useApi();
  const { data, error, isLoading, mutate } = useSWR(
    adminPaths.mechanics(),
    (p: string) => api.get<MechanicListRow[]>(p),
  );

  async function createMechanic(payload: {
    name: string;
    email?: string;
    phone?: string;
    timezone?: string;
    isActive?: boolean;
    authUserId?: string;
  }) {
    const created = await api.post<Mechanic>(adminPaths.mechanics(), payload);
    await mutate();
    return created;
  }

  return {
    mechanics: useStableArray(data),
    isLoading,
    isError: !!error,
    mutate,
    createMechanic,
  };
}

export function useAdminMechanic(id: number | null) {
  const api = useApi();
  const path = id != null ? adminPaths.mechanic(id) : null;
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) =>
    api.get<Mechanic>(p),
  );

  async function updateMechanic(patch: Partial<Mechanic>) {
    if (!id) throw new Error("No mechanic id");
    await api.patch<Mechanic>(adminPaths.mechanic(id), patch);
    await mutate();
  }

  async function deactivate() {
    if (!id) throw new Error("No mechanic id");
    await api.delete<{ success: true }>(adminPaths.mechanic(id));
    await mutate();
  }

  return {
    mechanic: data,
    isLoading,
    isError: !!error,
    mutate,
    updateMechanic,
    deactivate,
  };
}

export function useAdminMechanicAvailability(id: number | null) {
  const api = useApi();
  const path = id != null ? adminPaths.mechanicAvailability(id) : null;
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) =>
    api.get<WeeklyRow[]>(p),
  );

  async function saveAvailability(
    rows: Array<Pick<WeeklyRow, "dayOfWeek" | "startTime" | "endTime">>,
  ) {
    if (!id) throw new Error("No mechanic id");
    await api.put<WeeklyRow[]>(adminPaths.mechanicAvailability(id), {
      availability: rows,
    });
    await mutate();
  }

  return {
    availability: useStableArray(data),
    isLoading,
    isError: !!error,
    mutate,
    saveAvailability,
  };
}

export function useAdminMechanicOverrides(
  id: number | null,
  from?: string,
  to?: string,
) {
  const api = useApi();
  const path = id != null ? adminPaths.mechanicOverrides(id, from, to) : null;
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) =>
    api.get<ScheduleOverride[]>(p),
  );

  async function addOverride(payload: {
    overrideDate: string;
    isAvailable: boolean;
    startTime?: string;
    endTime?: string;
    reason?: string;
  }) {
    if (!id) throw new Error("No mechanic id");
    await api.post<ScheduleOverride>(adminPaths.mechanicOverrides(id), payload);
    await mutate();
  }

  async function deleteOverride(overrideId: number) {
    if (!id) throw new Error("No mechanic id");
    await api.delete<{ ok: true }>(adminPaths.mechanicOverride(id, overrideId));
    await mutate();
  }

  return {
    overrides: useStableArray(data),
    isLoading,
    isError: !!error,
    mutate,
    addOverride,
    deleteOverride,
  };
}

export function useAdminMechanicOrders(
  id: number | null,
  from?: string,
  to?: string,
) {
  const api = useApi();
  const path = id != null ? adminPaths.mechanicOrders(id, from, to) : null;
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) =>
    api.get<MechanicOrderRow[]>(p),
  );

  return {
    orders: useStableArray(data),
    isLoading,
    isError: !!error,
    mutate,
  };
}

export function useAssignMechanic() {
  const api = useApi();
  return function assign(
    orderId: number,
    payload: { providerId: number; force?: boolean },
  ): Promise<Order> {
    return api.post<Order>(adminPaths.assignProvider(orderId), payload);
  };
}
