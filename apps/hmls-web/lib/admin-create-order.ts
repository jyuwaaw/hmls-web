export const ORDER_DRAFT_KEY = "admin-create-order-draft";
export const PICKER_DRAFT_KEY = "admin-create-order-customer-picker";

/** Clears the walk-in order draft + customer-picker draft. Called on submit
 * success/cancel, and on sign-out so the next user on a shared terminal
 * doesn't see a half-filled walk-in order with the prior customer's PII. */
export function clearOrderDraft(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(ORDER_DRAFT_KEY);
    sessionStorage.removeItem(PICKER_DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export type ManualOrderForm = {
  customerId: string;
  vehicleYear: string;
  vehicleMake: string;
  vehicleModel: string;
  description: string;
  itemDescription: string;
  laborHours: string;
  partsCost: string;
};

export type CreateOrderPayload = {
  customer_id: number;
  vehicle_year?: number;
  vehicle_make?: string;
  vehicle_model?: string;
  description?: string;
  items?: Array<{
    description: string;
    labor_hours?: number;
    parts_cost?: number;
  }>;
};

export function emptyManualOrderForm(): ManualOrderForm {
  return {
    customerId: "",
    vehicleYear: "",
    vehicleMake: "",
    vehicleModel: "",
    description: "",
    itemDescription: "",
    laborHours: "",
    partsCost: "",
  };
}

function trimmed(value: string): string {
  return value.trim();
}

function optionalNumber(value: string): number | undefined {
  const next = trimmed(value);
  if (!next) return undefined;
  const parsed = Number(next);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validateManualOrderForm(form: ManualOrderForm): string | null {
  const customerId = Number(form.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return "Choose a customer before creating the order.";
  }

  if (!trimmed(form.description) && !trimmed(form.itemDescription)) {
    return "Add order notes or at least one service item.";
  }

  const vehicleYear = trimmed(form.vehicleYear);
  if (vehicleYear && !Number.isInteger(Number(vehicleYear))) {
    return "Vehicle year must be a whole number.";
  }

  for (const [label, value] of [
    ["Labor hours", form.laborHours],
    ["Parts cost", form.partsCost],
  ] as const) {
    const next = trimmed(value);
    if (next && (!Number.isFinite(Number(next)) || Number(next) < 0)) {
      return `${label} cannot be negative.`;
    }
  }

  if (
    !trimmed(form.itemDescription) &&
    (trimmed(form.laborHours) || trimmed(form.partsCost))
  ) {
    return "Add a service item description for the labor hours or parts cost you entered.";
  }

  return null;
}

export function buildCreateOrderPayload(
  form: ManualOrderForm,
): CreateOrderPayload {
  const payload: CreateOrderPayload = {
    customer_id: Number(form.customerId),
  };

  const vehicleYear = optionalNumber(form.vehicleYear);
  const vehicleMake = trimmed(form.vehicleMake);
  const vehicleModel = trimmed(form.vehicleModel);
  const description = trimmed(form.description);
  const itemDescription = trimmed(form.itemDescription);
  const laborHours = optionalNumber(form.laborHours);
  const partsCost = optionalNumber(form.partsCost);

  if (vehicleYear !== undefined) payload.vehicle_year = vehicleYear;
  if (vehicleMake) payload.vehicle_make = vehicleMake;
  if (vehicleModel) payload.vehicle_model = vehicleModel;
  if (description) payload.description = description;
  if (itemDescription) {
    const item: NonNullable<CreateOrderPayload["items"]>[number] = {
      description: itemDescription,
    };
    if (laborHours !== undefined) item.labor_hours = laborHours;
    if (partsCost !== undefined) item.parts_cost = partsCost;
    payload.items = [item];
  }

  return payload;
}
