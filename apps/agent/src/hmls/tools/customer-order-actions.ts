import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import type { OrderItem } from "@hmls/shared/db/schema";
import { toolResult } from "@hmls/shared/tool-result";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "../../common/convert-tools.ts";
import { patchItems, transition } from "../../services/order-state.ts";
import { customerAgentActor, toolResultFromOrderState } from "../../services/order-state-tool.ts";
import { shopHourlyRate } from "../skills/estimate/pricing.ts";

// `approve_order` and `decline_order` were removed: in the chat flow the
// order accumulates items + appointment + auto-assigned mechanic on a
// `draft`, and the customer's `schedule_order` call is itself the
// affirmative-consent signal (audited via `schedule_attached`). Admin's
// single Confirm click promotes draft → scheduled. Customers who change
// their mind use `cancel_order` instead. The legacy portal /approve and
// /decline endpoints remain for non-chat (PDF link) flows.

// ---------------------------------------------------------------------------
// Tool 1: cancel_order — customer-initiated cancel (pre-work only)
// ---------------------------------------------------------------------------

const cancelOrderTool = {
  name: "cancel_order",
  description: "Customer cancels an order. Allowed while the order is in 'draft', 'estimated' or " +
    "'scheduled' status (before any work begins). In-progress work must be handled by the shop.",
  schema: z.object({
    orderId: z.string().describe("The order ID to cancel"),
    reason: z.string().optional().describe("Optional reason for cancellation"),
  }),
  execute: async (
    params: { orderId: string; reason?: string },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    const actor = customerAgentActor(ctx);
    if (!actor) return toolResult({ success: false, error: "Authentication required" });

    const [order] = await db
      .select({ id: schema.orders.id, customerId: schema.orders.customerId })
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order || order.customerId !== ctx?.customerId) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    const result = await transition(id, "cancelled", actor, {
      reason: params.reason ?? "Cancelled by customer",
    });
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      newStatus: row.status,
      message: `Order #${row.id} has been cancelled.`,
    }));
  },
};

// ---------------------------------------------------------------------------
// Tool 4: modify_order_items
// ---------------------------------------------------------------------------

const modifyOrderItemsTool = {
  name: "modify_order_items",
  description:
    "Customer adds or removes service request items on a draft, revised, or estimated order. " +
    "Added items are priced automatically from the OLP labor database at the shop's standard " +
    "rate ($140/hr) and roll into the subtotal. If the vehicle or service isn't in OLP, the " +
    "item is added at $0 and the shop prices it during review. " +
    "IMPORTANT: if the order is in 'estimated' status (shop already sent the customer a quote), " +
    "modifying items flips the order back to 'revised' so the shop must re-review and re-send " +
    "the estimate. Before calling this tool on an estimated order, tell the customer: " +
    "'Changing this estimate will send it back to the shop for a new price — you'll get an updated quote.' " +
    "Only works when the order is in 'draft', 'revised', or 'estimated' status.",
  schema: z.object({
    orderId: z.string().describe("The order ID to modify"),
    addItems: z
      .array(
        z.object({
          name: z.string().describe("Short service name (e.g. 'Oil Change', 'Tire Rotation')"),
          description: z.string().optional().describe("Additional details or context"),
        }),
      )
      .optional()
      .describe("Service items to add. Pricing auto-looked-up from OLP when possible."),
    removeItemIds: z
      .array(z.string())
      .optional()
      .describe("Item IDs to remove from the order"),
  }),
  execute: async (
    params: {
      orderId: string;
      addItems?: Array<{ name: string; description?: string }>;
      removeItemIds?: string[];
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    const actor = customerAgentActor(ctx);
    if (!actor) return toolResult({ success: false, error: "Authentication required" });

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order || order.customerId !== ctx?.customerId) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    let items: OrderItem[] = Array.isArray(order.items) ? (order.items as OrderItem[]) : [];

    if (params.removeItemIds && params.removeItemIds.length > 0) {
      const removeSet = new Set(params.removeItemIds);
      items = items.filter((item) => !removeSet.has(item.id));
    }

    // Auto-price added items from OLP labor lookup at the shop's hourly
    // rate (matches the pricing engine). Missing lookups fall through at $0
    // so the shop prices them during review.
    if (params.addItems && params.addItems.length > 0) {
      const shopRateCents = await shopHourlyRate(order.shopId) ?? 14000;
      const vehicleInfo = order.vehicleInfo as
        | { year?: string; make?: string; model?: string }
        | null;
      const canLookup = Boolean(
        vehicleInfo?.year && vehicleInfo?.make && vehicleInfo?.model,
      );

      for (const req of params.addItems) {
        let laborHours: number | undefined;
        let sourceMeta: Record<string, unknown> | undefined;

        if (canLookup) {
          try {
            const { searchLaborTimes, findVehicles } = await import("./olp-client.ts");
            const vehicles = await findVehicles(
              vehicleInfo!.make!,
              vehicleInfo!.model!,
              Number(vehicleInfo!.year),
            );
            if (vehicles.length > 0) {
              const serviceWords = req.name.split(/\s+/).filter((w) => w.length > 1);
              const laborTimes = await searchLaborTimes(
                vehicles.map((v: { id: number }) => v.id),
                serviceWords,
                undefined,
              );
              if (laborTimes.length > 0) {
                laborHours = Number(laborTimes[0].labor_hours);
                sourceMeta = laborTimes[0].sourceMeta as Record<string, unknown>;
              }
            }
          } catch (_e) {
            // OLP unavailable — item added at $0; shop prices manually on review.
          }
        }

        const priceCents = laborHours !== undefined ? Math.round(laborHours * shopRateCents) : 0;
        const metadata: Record<string, unknown> = { customerRequested: true };
        if (sourceMeta) metadata.sourceMeta = sourceMeta;

        items.push(
          {
            id: randomUUID(),
            category: "labor",
            name: req.name,
            description: req.description,
            quantity: 1,
            unitPriceCents: priceCents,
            totalCents: priceCents,
            taxable: true,
            ...(laborHours !== undefined ? { laborHours } : {}),
            metadata,
          } as OrderItem & { metadata?: Record<string, unknown> },
        );
      }
    }

    const madeChange = (params.addItems?.length ?? 0) > 0 ||
      (params.removeItemIds?.length ?? 0) > 0;
    if (!madeChange) {
      return toolResult({ success: false, error: "No items added or removed" });
    }

    // Harness handles subtotal recompute, revisionNumber bump, events, and
    // the estimated -> revised flip.
    const result = await patchItems(id, { items }, actor, {
      metadata: {
        added: params.addItems?.map((i) => i.name) ?? [],
        removed: params.removeItemIds ?? [],
      },
    });
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      status: row.status,
      itemCount: items.length,
      message: `Order #${row.id} updated. ` +
        (params.addItems?.length
          ? `Added ${params.addItems.length} service(s) (priced automatically where possible). `
          : "") +
        (params.removeItemIds?.length ? `Removed ${params.removeItemIds.length} item(s). ` : "") +
        (row.status === "revised"
          ? "Since you changed an estimate the shop already sent, the shop will re-review and send an updated estimate."
          : ""),
    }));
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const customerOrderActionTools = [cancelOrderTool, modifyOrderItemsTool];
