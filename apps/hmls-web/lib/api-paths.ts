// Centralized path registry for every HMLS HTTP endpoint the web app hits.
// Functions return a full path ready to be appended to AGENT_URL. Only paths
// actually called from web code are listed; add new ones as the UI wires them.
//
// Mounting layout (see apps/gateway/src/hmls-app.ts):
//   /api/admin/*    → adminApp  (admin.ts + orders.ts + admin-mechanics.ts)
//   /api/portal/*   → portal.ts
//   /api/mechanic/* → mechanic.ts

export const adminPaths = {
  // --- admin.ts ---
  dashboard: () => "/api/admin/dashboard",
  customers: (search?: string) =>
    search
      ? `/api/admin/customers?search=${encodeURIComponent(search)}`
      : "/api/admin/customers",
  customer: (id: number | string) => `/api/admin/customers/${id}`,

  // --- orders.ts (mounted at /api/admin/orders) ---
  orders: (options?: { status?: string; search?: string }) => {
    const qs = new URLSearchParams();
    if (options?.status) qs.set("status", options.status);
    if (options?.search) qs.set("search", options.search);
    const s = qs.toString();
    return s ? `/api/admin/orders?${s}` : "/api/admin/orders";
  },
  order: (id: number | string) => `/api/admin/orders/${id}`,
  orderStatus: (id: number | string) => `/api/admin/orders/${id}/status`,
  orderSchedule: (id: number | string) => `/api/admin/orders/${id}/schedule`,
  orderPayment: (id: number | string) => `/api/admin/orders/${id}/payment`,
  orderContactLog: (id: number | string) =>
    `/api/admin/orders/${id}/contact-log`,

  // --- admin-mechanics.ts (mounted at /api/admin/mechanics) ---
  mechanics: () => "/api/admin/mechanics",
  mechanic: (id: number | string) => `/api/admin/mechanics/${id}`,
  mechanicAvailability: (id: number | string) =>
    `/api/admin/mechanics/${id}/availability`,
  mechanicOverrides: (
    id: number | string,
    dateFrom?: string,
    dateTo?: string,
  ) => {
    const qs = new URLSearchParams();
    if (dateFrom) qs.set("from", dateFrom);
    if (dateTo) qs.set("to", dateTo);
    const s = qs.toString();
    return `/api/admin/mechanics/${id}/overrides${s ? `?${s}` : ""}`;
  },
  mechanicOverride: (id: number | string, oid: number | string) =>
    `/api/admin/mechanics/${id}/overrides/${oid}`,
  mechanicOrders: (id: number | string, from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const s = qs.toString();
    return `/api/admin/mechanics/${id}/orders${s ? `?${s}` : ""}`;
  },
  // POST /api/admin/mechanics/orders/:orderId/assign
  assignProvider: (orderId: number | string) =>
    `/api/admin/mechanics/orders/${orderId}/assign`,
};

export const portalPaths = {
  me: () => "/api/portal/me",
  updateMe: () => "/api/portal/me",
  orders: () => "/api/portal/me/orders",
  order: (id: number | string) => `/api/portal/me/orders/${id}`,
  bookings: () => "/api/portal/me/bookings",
  approve: (id: number | string) => `/api/portal/me/orders/${id}/approve`,
  decline: (id: number | string) => `/api/portal/me/orders/${id}/decline`,
  cancelBooking: (id: number | string) =>
    `/api/portal/me/orders/${id}/cancel-booking`,
  cancel: (id: number | string) => `/api/portal/me/orders/${id}/cancel`,
};

export const mechanicPaths = {
  me: () => "/api/mechanic/me",
  availability: () => "/api/mechanic/availability",
  overrides: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const s = qs.toString();
    return `/api/mechanic/overrides${s ? `?${s}` : ""}`;
  },
  orders: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const s = qs.toString();
    return `/api/mechanic/orders${s ? `?${s}` : ""}`;
  },
  orderTransition: (id: number | string) =>
    `/api/mechanic/orders/${id}/transition`,
  orderPayment: (id: number | string) => `/api/mechanic/orders/${id}/payment`,
};
