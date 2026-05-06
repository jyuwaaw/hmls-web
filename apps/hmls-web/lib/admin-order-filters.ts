const ADMIN_ORDER_FILTERS = [
  "draft",
  "estimated",
  "approved",
  "scheduled",
  "in_progress",
  "completed",
  "declined",
  "revised",
  "cancelled",
] as const;

export type AdminOrdersFilter = "" | (typeof ADMIN_ORDER_FILTERS)[number];

const ADMIN_ORDER_FILTER_SET = new Set<string>(ADMIN_ORDER_FILTERS);

export function parseAdminOrdersFilter(
  value: string | null | undefined,
): AdminOrdersFilter {
  return value && ADMIN_ORDER_FILTER_SET.has(value)
    ? (value as AdminOrdersFilter)
    : "";
}

export function parseAdminOrdersSearch(
  value: string | null | undefined,
): string {
  return value?.trim() ?? "";
}

function buildOrdersQuery(
  filter: AdminOrdersFilter,
  search?: string,
  filterParam: "status" | "fromStatus" = "status",
): string {
  const qs = new URLSearchParams();
  if (filter) qs.set(filterParam, filter);
  const trimmedSearch = search?.trim();
  if (trimmedSearch) qs.set("search", trimmedSearch);
  return qs.toString();
}

export function getAdminOrdersListHref(
  filter: AdminOrdersFilter,
  search?: string,
): string {
  const qs = buildOrdersQuery(filter, search, "status");
  return qs ? `/admin/orders?${qs}` : "/admin/orders";
}

export function getAdminOrderDetailHref(
  orderId: number | string,
  filter: AdminOrdersFilter,
  search?: string,
): string {
  const qs = buildOrdersQuery(filter, search, "fromStatus");
  const baseHref = `/admin/orders/${orderId}`;
  return qs ? `${baseHref}?${qs}` : baseHref;
}
