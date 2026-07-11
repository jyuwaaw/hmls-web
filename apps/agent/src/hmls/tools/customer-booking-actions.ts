import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { ToolContext } from "../../common/convert-tools.ts";
import { transition } from "../../services/order-state.ts";
import { customerAgentActor, toolResultFromOrderState } from "../../services/order-state-tool.ts";

// After Layer 3 there is no separate bookings entity — scheduling lives on
// the order. Customer-driven scheduling itself is done via the shared
// `schedule_order` tool (common/tools/schedule.ts). This file holds only
// the customer-side cancel path.

const cancelBookingTool = {
  name: "cancel_booking",
  description:
    "Customer cancels their booked appointment. Only allowed before work begins (the order is " +
    "'approved' with a scheduled time). Once the shop has started work, cancellations must go " +
    "through staff.",
  schema: z.object({
    orderId: z.string().describe("The order ID to cancel the appointment on"),
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

    const result = await transition(id, "cancelled", actor, { reason: params.reason });
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      newStatus: row.status,
      message: `Your appointment for order #${row.id} has been cancelled.`,
    }));
  },
};

export const customerBookingActionTools = [cancelBookingTool];
