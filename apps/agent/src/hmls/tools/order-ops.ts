import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { type AccessCtx, canWrite, orderAccessible, OWNER_ALL_SHOPS } from "../../db/tenant.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { ToolContext } from "../../common/convert-tools.ts";
import {
  addNote,
  allowedTransitions,
  type OrderStatus,
  transition,
} from "../../services/order-state.ts";
import {
  customerAgentActor,
  staffAgentActor,
  toolResultFromOrderState,
} from "../../services/order-state-tool.ts";

const ORDER_STATUSES = [
  "draft",
  "estimated",
  "revised",
  "approved",
  "declined",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const;

// ---------------------------------------------------------------------------
// Tool 1: transition_order_status (staff + customer fallback)
// ---------------------------------------------------------------------------

const transitionOrderStatusTool = {
  name: "transition_order_status",
  description:
    "Transition an order to a new status. The harness validates the transition against the " +
    "state machine AND the caller's role permissions. Use get_order_status first to confirm " +
    "the current status.",
  schema: z.object({
    orderId: z.string().describe("The order ID (numeric string or number)"),
    newStatus: z
      .enum(ORDER_STATUSES)
      .describe("The target status to transition to"),
    reason: z
      .string()
      .optional()
      .describe("Optional reason (stored on cancelled/declined orders, otherwise audit-only)"),
  }),
  execute: async (
    params: {
      orderId: string;
      newStatus: (typeof ORDER_STATUSES)[number];
      reason?: string;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    // Ownership pre-flight (WRITE). Reject cross-tenant transitions and
    // owner-no-shop writes; mirror the harness's "not found" shape so we
    // don't leak existence.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }
    // Staff chat is the primary caller; if a customer ctx is somehow set we
    // respect it so customer-initiated transitions (approve / decline /
    // cancel) still work through this generic entry point.
    const actor = customerAgentActor(ctx) ?? staffAgentActor(ctx);

    const result = await transition(id, params.newStatus as OrderStatus, actor, {
      reason: params.reason,
    });
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      newStatus: row.status,
      message: `Order #${row.id} transitioned to '${row.status}'`,
    }));
  },
};

// ---------------------------------------------------------------------------
// Tool 2: add_order_note
// ---------------------------------------------------------------------------

const addOrderNoteTool = {
  name: "add_order_note",
  description: "Add an internal note to an order's audit log. Use this to record context, " +
    "customer communications, or follow-up actions that aren't status changes.",
  schema: z.object({
    orderId: z.string().describe("The order ID (numeric string or number)"),
    note: z.string().describe("The note text to add to the order"),
  }),
  execute: async (
    params: { orderId: string; note: string },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    // Ownership pre-flight (WRITE) — same rule as transition_order_status.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }
    const actor = customerAgentActor(ctx) ?? staffAgentActor(ctx);
    const result = await addNote(id, params.note, actor);
    return toolResultFromOrderState(result, (v) => ({
      eventId: v.eventId,
      orderId: id,
      message: `Note added to order #${id}`,
    }));
  },
};

// ---------------------------------------------------------------------------
// Tool 3: get_order_status (read-only, no harness needed)
// ---------------------------------------------------------------------------

const getOrderStatusTool = {
  name: "get_order_status",
  description: "Look up an order's current status, line item summary, and next expected step. " +
    "Can search by order ID, customer email, or customer phone number.",
  schema: z.object({
    orderId: z
      .string()
      .optional()
      .describe("The order ID to look up directly"),
    customerEmail: z
      .string()
      .optional()
      .describe("Customer email address to find their most recent order"),
    customerPhone: z
      .string()
      .optional()
      .describe("Customer phone number to find their most recent order"),
  }),
  execute: async (
    params: {
      orderId?: string;
      customerEmail?: string;
      customerPhone?: string;
    },
    ctx: ToolContext | undefined,
  ) => {
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    const isCustomer = ctxAccess.customerId != null;
    const staffShopId = !isCustomer && ctxAccess.shopId && ctxAccess.shopId !== OWNER_ALL_SHOPS
      ? ctxAccess.shopId
      : null;

    // No context at all → deny (don't leak any order).
    if (!isCustomer && !ctxAccess.shopId) {
      return toolResult({ success: false, error: "No order found" });
    }

    if (!params.orderId && !params.customerEmail && !params.customerPhone) {
      return toolResult({
        success: false,
        error: "Provide at least one of: orderId, customerEmail, or customerPhone",
      });
    }

    let order: typeof schema.orders.$inferSelect | undefined;

    if (params.orderId) {
      const id = Number(params.orderId);
      if (!Number.isInteger(id) || id <= 0) {
        return toolResult({ success: false, error: "Invalid order ID" });
      }
      // Ownership pre-flight on the by-id path.
      if (!(await orderAccessible(id, ctxAccess))) {
        return toolResult({ success: false, error: "No order found" });
      }
      const [row] = await db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id))
        .limit(1);
      order = row;
    } else if (isCustomer) {
      // Customer agent: ignore the email/phone cross-lookup entirely — a
      // customer only ever sees their OWN orders. Return their most-recent
      // non-terminal order, falling back to any of their orders.
      const ownedActive = and(
        eq(schema.orders.customerId, ctxAccess.customerId!),
        sql`${schema.orders.status} NOT IN ('cancelled', 'completed')`,
      );
      const [row] = await db
        .select()
        .from(schema.orders)
        .where(ownedActive)
        .orderBy(desc(schema.orders.createdAt))
        .limit(1);
      if (row) {
        order = row;
      } else {
        const [anyRow] = await db
          .select()
          .from(schema.orders)
          .where(eq(schema.orders.customerId, ctxAccess.customerId!))
          .orderBy(desc(schema.orders.createdAt))
          .limit(1);
        order = anyRow;
      }
    } else {
      // Staff / owner: look the customer up by email or phone, scoped to the
      // staff caller's shop (owner all-shops may span shops). Then their
      // most-recent order, also shop-scoped for staff.
      const customer = await (async () => {
        const ident = params.customerEmail
          ? eq(schema.customers.email, params.customerEmail)
          : params.customerPhone
          ? eq(schema.customers.phone, params.customerPhone)
          : undefined;
        if (!ident) return undefined;
        const where = staffShopId ? and(ident, eq(schema.customers.shopId, staffShopId)) : ident;
        const [row] = await db.select().from(schema.customers).where(where).limit(1);
        return row;
      })();

      if (!customer) {
        return toolResult({
          success: false,
          error: "No customer found with that email or phone",
        });
      }

      const shopScope = staffShopId ? eq(schema.orders.shopId, staffShopId) : undefined;
      const [row] = await db
        .select()
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.customerId, customer.id),
            sql`${schema.orders.status} NOT IN ('cancelled', 'completed')`,
            shopScope,
          ),
        )
        .orderBy(desc(schema.orders.createdAt))
        .limit(1);

      if (!row) {
        const [anyRow] = await db
          .select()
          .from(schema.orders)
          .where(and(eq(schema.orders.customerId, customer.id), shopScope))
          .orderBy(desc(schema.orders.createdAt))
          .limit(1);
        order = anyRow;
      } else {
        order = row;
      }
    }

    if (!order) {
      return toolResult({ success: false, error: "No order found" });
    }

    const nextSteps = allowedTransitions(order.status as OrderStatus);
    const nextStepHint = nextSteps.length > 0
      ? `Next allowed transitions: ${nextSteps.join(", ")}`
      : "Order is in a terminal state";

    const items = Array.isArray(order.items) ? order.items : [];
    const itemSummary = items.map((item) =>
      `${item.name} (${item.category}) x${item.quantity} @ $${
        (item.unitPriceCents / 100).toFixed(2)
      }`
    );

    return toolResult({
      success: true,
      orderId: order.id,
      status: order.status,
      contactName: order.contactName,
      contactEmail: order.contactEmail,
      contactPhone: order.contactPhone,
      subtotalCents: order.subtotalCents,
      subtotalFormatted: `$${((order.subtotalCents ?? 0) / 100).toFixed(2)}`,
      itemCount: items.length,
      itemSummary,
      notes: order.notes,
      adminNotes: order.adminNotes,
      cancellationReason: order.cancellationReason,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      nextStepHint,
    });
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const orderOpsTools = [
  transitionOrderStatusTool,
  addOrderNoteTool,
  getOrderStatusTool,
];
