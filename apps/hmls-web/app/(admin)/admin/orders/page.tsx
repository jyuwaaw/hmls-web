"use client";

import { ChevronRight, ClipboardList, Plus, Save } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateTime } from "@/components/ui/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type Customer,
  useAdminCustomer,
  useAdminCustomers,
  useAdminDashboard,
  useAdminOrders,
} from "@/hooks/useAdmin";
import { useApi } from "@/hooks/useApi";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  buildCreateOrderPayload,
  clearOrderDraft,
  emptyManualOrderForm,
  type ManualOrderForm,
  ORDER_DRAFT_KEY,
  PICKER_DRAFT_KEY,
  validateManualOrderForm,
} from "@/lib/admin-create-order";
import {
  type AdminOrdersFilter,
  getAdminOrderDetailHref,
  getAdminOrdersListHref,
  parseAdminOrdersFilter,
  parseAdminOrdersSearch,
} from "@/lib/admin-order-filters";
import { adminPaths } from "@/lib/api-paths";
import { formatCents } from "@/lib/format";
import { ORDER_STATUS, type StatusConfig } from "@/lib/status-display";
import { cn } from "@/lib/utils";

/* ── Helpers ──────────────────────────────────────────────────────────── */

function OrderStatusBadge({
  status,
  config,
}: {
  status: string;
  config: Record<string, StatusConfig>;
}) {
  const entry = config[status] ?? {
    label: status,
    color: "bg-neutral-100 text-neutral-500",
  };
  return (
    <Badge variant="outline" className={cn(entry.color)}>
      {entry.label}
    </Badge>
  );
}

/* ── Grouped filters ────────────────────────────────────────────────── */

const FILTER_GROUPS = [
  { value: "", label: "All" },
  { value: "draft", label: "Pending Review" },
  { value: "estimated", label: "Sent" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
] satisfies { value: AdminOrdersFilter; label: string }[];

const MORE_FILTERS = [
  { value: "declined", label: "Declined" },
  { value: "revised", label: "Revised" },
  { value: "cancelled", label: "Cancelled" },
] satisfies { value: AdminOrdersFilter; label: string }[];

/* ── Manual create order dialog ──────────────────────────────────────── */

function customerLabel(customer: Customer) {
  return (
    [customer.name, customer.phone, customer.email]
      .filter(Boolean)
      .join(" · ") || `Customer #${customer.id}`
  );
}

const emptyCustomerDraft = {
  name: "",
  phone: "",
  email: "",
  address: "",
};

type PickerDraft = {
  mode: "search" | "create";
  search: string;
  draft: typeof emptyCustomerDraft;
};

const emptyPickerDraft: PickerDraft = {
  mode: "search",
  search: "",
  draft: emptyCustomerDraft,
};

function readOrderDraft(): ManualOrderForm {
  if (typeof window === "undefined") return emptyManualOrderForm();
  try {
    const raw = sessionStorage.getItem(ORDER_DRAFT_KEY);
    if (!raw) return emptyManualOrderForm();
    const parsed = JSON.parse(raw) as Partial<ManualOrderForm>;
    return { ...emptyManualOrderForm(), ...parsed };
  } catch {
    return emptyManualOrderForm();
  }
}

function readPickerDraft(): PickerDraft {
  if (typeof window === "undefined") return emptyPickerDraft;
  try {
    const raw = sessionStorage.getItem(PICKER_DRAFT_KEY);
    if (!raw) return emptyPickerDraft;
    const parsed = JSON.parse(raw) as Partial<PickerDraft>;
    return {
      mode: parsed.mode === "create" ? "create" : "search",
      search: typeof parsed.search === "string" ? parsed.search : "",
      draft: { ...emptyCustomerDraft, ...(parsed.draft ?? {}) },
    };
  } catch {
    return emptyPickerDraft;
  }
}

// /api/admin/customers caps at 100 rows. Drive search through the endpoint's
// query parameter so customers past the cap stay reachable, and let the
// admin create a new customer inline for walk-ins.
function CustomerPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const api = useApi();
  // Lazy-init each piece from sessionStorage so an accidental dialog close
  // doesn't lose a half-typed customer or in-flight search.
  const initialPicker = readPickerDraft();
  const [mode, setMode] = useState<"search" | "create">(initialPicker.mode);
  const [search, setSearch] = useState(initialPicker.search);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [draft, setDraft] = useState(initialPicker.draft);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Persist whenever any of these change. The order draft hits its own
  // useEffect in CreateOrderDialog; this covers picker-local state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(
      PICKER_DRAFT_KEY,
      JSON.stringify({ mode, search, draft }),
    );
  }, [mode, search, draft]);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const hasSearch = debouncedSearch.length > 0;
  const {
    customers,
    isLoading,
    mutate: mutateCustomers,
  } = useAdminCustomers(debouncedSearch || undefined, hasSearch);

  // Hydrate `selected` when value comes back from a restored draft
  // (sessionStorage holds the customerId only, not the customer object).
  const numericValue = value ? Number(value) : Number.NaN;
  const needsHydration =
    Number.isInteger(numericValue) &&
    numericValue > 0 &&
    (!selected || selected.id !== numericValue);
  const { data: hydrationData } = useAdminCustomer(
    needsHydration ? numericValue : null,
  );

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (hydrationData?.customer && hydrationData.customer.id === numericValue) {
      setSelected(hydrationData.customer);
    }
  }, [value, numericValue, hydrationData]);

  const selectCustomer = (customer: Customer) => {
    setSelected(customer);
    onChange(String(customer.id));
  };

  const handleCreate = async () => {
    const name = draft.name.trim();
    const phone = draft.phone.trim();
    const email = draft.email.trim();
    const address = draft.address.trim();
    if (!name && !phone && !email) {
      setCreateError("Add a name, phone, or email.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const customer = await api.post<Customer>(adminPaths.customers(), {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(email && { email }),
        ...(address && { address }),
      });
      await mutateCustomers();
      setMode("search");
      setDraft(emptyCustomerDraft);
      selectCustomer(customer);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Create customer failed");
    } finally {
      setCreating(false);
    }
  };

  if (selected) {
    return (
      <div className="space-y-1.5">
        <Label>Customer</Label>
        <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
          <span className="truncate">{customerLabel(selected)}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setSelected(null);
              onChange("");
              setSearch("");
            }}
          >
            Change
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "create") {
    const setField = (key: keyof typeof draft, val: string) =>
      setDraft((d) => ({ ...d, [key]: val }));
    return (
      <div className="space-y-1.5">
        <Label>New customer</Label>
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            value={draft.name}
            onChange={(e) => setField("name", e.target.value)}
            placeholder="Name"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input
              value={draft.phone}
              onChange={(e) => setField("phone", e.target.value)}
              placeholder="Phone"
            />
            <Input
              value={draft.email}
              onChange={(e) => setField("email", e.target.value)}
              placeholder="Email"
            />
          </div>
          <Input
            value={draft.address}
            onChange={(e) => setField("address", e.target.value)}
            placeholder="Address (optional)"
          />
          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setMode("search");
                setCreateError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? "Creating..." : "Save customer"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="manual-order-customer-search">Customer</Label>
      <Input
        id="manual-order-customer-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, phone, or email"
      />
      {hasSearch && (
        <div className="max-h-44 overflow-y-auto rounded-md border border-border">
          {isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Loading...
            </div>
          ) : customers.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No customers match.
            </div>
          ) : (
            customers.map((customer) => (
              <button
                type="button"
                key={customer.id}
                onClick={() => selectCustomer(customer)}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-muted"
              >
                {customerLabel(customer)}
              </button>
            ))
          )}
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setMode("create")}
        className="self-start"
      >
        <Plus className="w-3 h-3" />
        New customer
      </Button>
    </div>
  );
}

function ManualOrderFormFields({
  form,
  onChange,
}: {
  form: ManualOrderForm;
  onChange: (form: ManualOrderForm) => void;
}) {
  const set = (key: keyof ManualOrderForm, value: string) =>
    onChange({ ...form, [key]: value });

  return (
    <div className="space-y-4">
      <CustomerPicker
        value={form.customerId}
        onChange={(id) => set("customerId", id)}
      />

      <div className="space-y-1.5">
        <Label htmlFor="manual-order-description">
          What does the customer need?
        </Label>
        <Textarea
          id="manual-order-description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="A short summary is fine — the shop reviews before sending."
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="manual-order-vehicle-year">Vehicle</Label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input
            id="manual-order-vehicle-year"
            inputMode="numeric"
            value={form.vehicleYear}
            onChange={(e) => set("vehicleYear", e.target.value)}
            placeholder="Year"
          />
          <Input
            value={form.vehicleMake}
            onChange={(e) => set("vehicleMake", e.target.value)}
            placeholder="Make"
          />
          <Input
            value={form.vehicleModel}
            onChange={(e) => set("vehicleModel", e.target.value)}
            placeholder="Model"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="manual-order-item-description">Service line</Label>
        <Input
          id="manual-order-item-description"
          value={form.itemDescription}
          onChange={(e) => set("itemDescription", e.target.value)}
          placeholder="Example: Brake inspection"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input
            inputMode="decimal"
            value={form.laborHours}
            onChange={(e) => set("laborHours", e.target.value)}
            placeholder="Labor hours"
          />
          <Input
            inputMode="decimal"
            value={form.partsCost}
            onChange={(e) => set("partsCost", e.target.value)}
            placeholder="Parts cost"
          />
        </div>
      </div>
    </div>
  );
}

function CreateOrderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const api = useApi();
  // Lazy-init from sessionStorage so an accidental close (Esc, click outside,
  // refresh) doesn't lose what the admin typed. Cancel and Create both
  // clear the draft explicitly.
  const [form, setForm] = useState<ManualOrderForm>(readOrderDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Platform-specific hint. null on first render avoids hydration mismatch
  // and keeps the kbd badge from showing the wrong modifier.
  const [shortcutHint, setShortcutHint] = useState<string | null>(null);
  useEffect(() => {
    const ua =
      typeof navigator !== "undefined"
        ? navigator.platform || navigator.userAgent
        : "";
    setShortcutHint(/Mac|iPad|iPhone|iPod/.test(ua) ? "⌘↵" : "Ctrl+↵");
  }, []);

  // Persist whenever form changes. Empty form still writes (cheap), and the
  // explicit clear paths below remove the key.
  useEffect(() => {
    if (typeof window !== "undefined") {
      sessionStorage.setItem(ORDER_DRAFT_KEY, JSON.stringify(form));
    }
  }, [form]);

  const resetForm = () => {
    setForm(emptyManualOrderForm());
    setError(null);
    setSaving(false);
    clearOrderDraft();
  };

  const handleCreate = async () => {
    const validationError = validateManualOrderForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const order = await api.post<{ id: number }>(
        adminPaths.orders(),
        buildCreateOrderPayload(form),
      );
      resetForm();
      onCreated(order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create order failed");
      setSaving(false);
    }
  };

  const handleCancel = () => {
    resetForm();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          // Soft close (Esc, outside-click): preserve form, clear transient
          // error/saving so the next open doesn't show a stale state.
          setError(null);
          setSaving(false);
        }
      }}
    >
      <DialogContent
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !saving) {
            e.preventDefault();
            handleCreate();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display">New Order</DialogTitle>
          <DialogDescription>
            Create a draft for review. Vehicle and service line are optional.
          </DialogDescription>
        </DialogHeader>

        <ManualOrderFormFields form={form} onChange={setForm} />

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={saving}
            title={shortcutHint ? `${shortcutHint} to create` : "Create order"}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Creating..." : "Create Order"}
            {shortcutHint && (
              <kbd className="ml-1 hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono opacity-70">
                {shortcutHint}
              </kbd>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Skeleton loading state ───────────────────────────────────────────── */

function OrdersSkeleton() {
  return (
    <div className="space-y-2">
      {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
        <Skeleton key={id} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export default function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = parseAdminOrdersFilter(searchParams.get("status"));
  const urlSearch = parseAdminOrdersSearch(searchParams.get("search"));
  const [searchInput, setSearchInput] = useState(urlSearch);
  // 300ms debounce so fetch + URL sync only fire after the user pauses typing.
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [showMore, setShowMore] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const {
    orders,
    isLoading,
    mutate: mutateOrders,
  } = useAdminOrders(filter || undefined, debouncedSearch || undefined);
  const { data: dashboard } = useAdminDashboard();
  const pendingReviewCount = dashboard?.stats.pendingReview ?? 0;

  // Sync deferred search into the URL so refresh, back/forward, and shared
  // links keep the active query.
  useEffect(() => {
    const desired = getAdminOrdersListHref(filter, debouncedSearch);
    const current = getAdminOrdersListHref(filter, urlSearch);
    if (desired !== current) {
      router.replace(desired, { scroll: false });
    }
  }, [debouncedSearch, filter, urlSearch, router]);

  const isMoreActive = MORE_FILTERS.some((f) => f.value === filter);
  const setFilter = (nextFilter: typeof filter) => {
    router.replace(getAdminOrdersListHref(nextFilter, debouncedSearch), {
      scroll: false,
    });
  };
  const handleOrderCreated = async (id: number) => {
    setShowCreate(false);
    await mutateOrders();
    router.push(getAdminOrderDetailHref(id, filter, debouncedSearch));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-display font-bold text-foreground">
          Orders
        </h1>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4" />
          New Order
        </Button>
      </div>

      <CreateOrderDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={handleOrderCreated}
      />

      <div className="mb-4">
        <Input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, phone, email, vehicle, notes, or order ID"
          aria-label="Search orders"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {FILTER_GROUPS.map((opt) => {
          const showCount = opt.value === "draft" && pendingReviewCount > 0;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={cn(
                "text-xs font-medium px-3 py-1.5 rounded-full transition-colors inline-flex items-center gap-1.5",
                filter === opt.value
                  ? "bg-primary text-white"
                  : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary",
              )}
            >
              {opt.label}
              {showCount && (
                <span
                  className={cn(
                    "rounded-full text-[10px] leading-none px-1.5 py-0.5 font-semibold",
                    filter === opt.value
                      ? "bg-white text-primary"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
                  )}
                >
                  {pendingReviewCount}
                </span>
              )}
            </button>
          );
        })}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className={cn(
              "text-xs font-medium px-3 py-1.5 rounded-full transition-colors",
              isMoreActive
                ? "bg-primary text-white"
                : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary",
            )}
          >
            More {showMore ? "\u25B2" : "\u25BC"}
          </button>
          {showMore && (
            <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-10 py-1 min-w-[140px]">
              {MORE_FILTERS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setFilter(opt.value);
                    setShowMore(false);
                  }}
                  className={cn(
                    "w-full text-left text-xs px-3 py-1.5 hover:bg-muted transition-colors",
                    filter === opt.value
                      ? "text-primary font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <OrdersSkeleton />
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ClipboardList className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              {debouncedSearch
                ? `No orders match "${debouncedSearch}".`
                : filter
                  ? `No ${filter} orders.`
                  : "No orders yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => {
            const vehicle = order.vehicleInfo;
            const vehicleStr = vehicle
              ? [vehicle.year, vehicle.make, vehicle.model]
                  .filter(Boolean)
                  .join(" ")
              : null;
            const items = order.items ?? [];

            return (
              <Link
                key={order.id}
                href={getAdminOrderDetailHref(
                  order.id,
                  filter,
                  debouncedSearch,
                )}
                prefetch={false}
                className="flex items-center justify-between gap-3 bg-card border border-border rounded-xl p-4 hover:border-primary transition-colors group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      #{order.id}
                    </span>
                    <OrderStatusBadge
                      status={order.status}
                      config={ORDER_STATUS}
                    />
                    {order.revisionNumber > 1 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">
                        v{order.revisionNumber}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                    {order.contactName ?? "Unknown"}
                    {vehicleStr && ` \u00B7 ${vehicleStr}`}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    <DateTime value={order.createdAt} format="datetime" />
                  </span>
                  {items.length > 0 && (
                    <span className="text-xs font-medium text-foreground">
                      {formatCents(order.subtotalCents ?? 0)}
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
