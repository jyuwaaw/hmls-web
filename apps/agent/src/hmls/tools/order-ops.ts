import { z } from "zod";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { type AccessCtx, canWrite, orderAccessible, OWNER_ALL_SHOPS } from "../../db/tenant.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { ToolContext } from "../../common/convert-tools.ts";
import {
  addNote,
  allowedTransitions,
  assignProvider,
  canonicalizeStatus,
  type OrderStatus,
  PAYMENT_METHODS,
  type PaymentMethod,
  recordPayment,
  transition,
} from "../../services/order-state.ts";
import { AUTHORIZATION_CHANNELS, type OrderAuthorization } from "@hmls/shared/order/status";
import {
  customerAgentActor,
  staffAgentActor,
  toolResultFromOrderState,
} from "../../services/order-state-tool.ts";

// Canonical 7-state machine — the LLM should never target the retired
// 'scheduled'/'revised' labels (transition() would map them anyway, but the
// schema shouldn't advertise them).
const ORDER_STATUSES = [
  "draft",
  "estimated",
  "approved",
  "declined",
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
    "the current status. SENSITIVE — CANCELLATION IS TERMINAL: never transition to 'cancelled' " +
    'on a first-pass guess. First echo the order and the reason to the human (e.g. "Cancel ' +
    'order #42 — customer no-show. Confirm?") and only call after they confirm in this ' +
    "conversation.",
  schema: z.object({
    orderId: z.string().describe("The order ID (numeric string or number)"),
    newStatus: z
      .enum(ORDER_STATUSES)
      .describe("The target status to transition to"),
    reason: z
      .string()
      .optional()
      .describe("Optional reason (stored on cancelled/declined orders, otherwise audit-only)"),
    authorization: z
      .object({
        channel: z
          .enum(AUTHORIZATION_CHANNELS)
          .describe("How the customer authorized: portal, text, call, or in_person"),
        note: z
          .string()
          .optional()
          .describe("Optional context, e.g. 'spoke with owner at 10:30am'"),
      })
      .optional()
      .describe(
        "Customer-authorization evidence. REQUIRED when transitioning to 'approved' (including " +
          "the draft→approved walk-in shortcut) — this edge records how the customer approved " +
          "the work. If you do not know which channel the customer used, ASK the user first; " +
          "never guess.",
      ),
  }),
  execute: async (
    params: {
      orderId: string;
      newStatus: (typeof ORDER_STATUSES)[number];
      reason?: string;
      authorization?: OrderAuthorization;
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
      authorization: params.authorization,
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

    // Canonical status for the LLM — a window-period physical 'scheduled' /
    // 'revised' row reads as its canonical state.
    const status: OrderStatus = canonicalizeStatus(order.status);
    const nextSteps = allowedTransitions(status);
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
      status,
      scheduledAt: order.scheduledAt,
      providerId: order.providerId,
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
// Tool 4: assign_mechanic (staff-only — registered via staffOrderOpsTools)
// ---------------------------------------------------------------------------

const assignMechanicTool = {
  name: "assign_mechanic",
  description: "Assign (dispatch) a mechanic to an order — no status change. Pass providerId " +
    "when known; otherwise pass the mechanic's name and it is resolved within the shop " +
    "(ambiguous or unknown names return the candidates so you can retry). " +
    "SENSITIVE — RE-DISPATCH: if the order already has a DIFFERENT mechanic assigned, do not " +
    'swap them on a first-pass guess. First echo the change to the human (e.g. "Order #42 is ' +
    'assigned to Jake — replace with Maria?"), and only after they confirm in this ' +
    "conversation, call again with confirmReassign: true.",
  schema: z.object({
    orderId: z.string().describe("The order ID (numeric string or number)"),
    providerId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The mechanic's provider ID (preferred when known)"),
    providerName: z
      .string()
      .optional()
      .describe("Mechanic name to resolve within the shop when providerId is unknown"),
    confirmReassign: z
      .boolean()
      .optional()
      .describe(
        "Required (true) only when the order already has a different mechanic assigned. Set " +
          "ONLY after the human has confirmed the re-dispatch in this conversation.",
      ),
    force: z
      .boolean()
      .optional()
      .describe("Admin override: allow assigning an inactive mechanic"),
  }),
  execute: async (
    params: {
      orderId: string;
      providerId?: number;
      providerName?: string;
      confirmReassign?: boolean;
      force?: boolean;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    if (params.providerId == null && !params.providerName?.trim()) {
      return toolResult({
        success: false,
        error: "Provide providerId or providerName to pick a mechanic",
      });
    }
    // Ownership pre-flight (WRITE) — same rule as transition_order_status.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    // Resolve the mechanic. Name resolution doubles as discovery: no
    // list_providers tool exists, so error messages list the shop's active
    // mechanics for the model to retry with.
    let providerId = params.providerId;
    let providerName: string | undefined;
    if (providerId == null) {
      const term = params.providerName!.trim();
      const matches = await db
        .select({ id: schema.providers.id, name: schema.providers.name })
        .from(schema.providers)
        .where(
          and(
            eq(schema.providers.shopId, order.shopId),
            ilike(schema.providers.name, `%${term}%`),
          ),
        );
      if (matches.length === 0) {
        const active = await db
          .select({ id: schema.providers.id, name: schema.providers.name })
          .from(schema.providers)
          .where(
            and(eq(schema.providers.shopId, order.shopId), eq(schema.providers.isActive, true)),
          );
        const roster = active.map((p) => `${p.name} (#${p.id})`).join(", ") || "none";
        return toolResult({
          success: false,
          error: `No mechanic matching "${term}" in this shop. Active mechanics: ${roster}`,
        });
      }
      if (matches.length > 1) {
        const candidates = matches.map((p) => `${p.name} (#${p.id})`).join(", ");
        return toolResult({
          success: false,
          error: `Ambiguous mechanic name "${term}" — matches: ${candidates}. ` +
            "Ask the user which one, then re-call with that providerId.",
        });
      }
      providerId = matches[0].id;
      providerName = matches[0].name;
    }

    // Re-dispatch confirmation fence (Codex C8): overwriting an existing
    // assignment requires an explicit in-chat confirmation from the human.
    if (
      order.providerId != null && order.providerId !== providerId && !params.confirmReassign
    ) {
      const [current] = await db
        .select({ name: schema.providers.name })
        .from(schema.providers)
        .where(eq(schema.providers.id, order.providerId))
        .limit(1);
      const currentLabel = current
        ? `${current.name} (#${order.providerId})`
        : `#${order.providerId}`;
      return toolResult({
        success: false,
        error: `Order #${id} is already assigned to mechanic ${currentLabel}. Re-dispatching ` +
          "replaces them — confirm the swap with the user first, then re-call with " +
          "confirmReassign: true.",
      });
    }

    const actor = customerAgentActor(ctx) ?? staffAgentActor(ctx);
    const result = await assignProvider(id, providerId, actor, { force: params.force });
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      providerId: row.providerId,
      message: `Order #${row.id} assigned to mechanic ${
        providerName ? `${providerName} (#${row.providerId})` : `#${row.providerId}`
      }`,
    }));
  },
};

// ---------------------------------------------------------------------------
// Tool 5: record_payment (staff-only — registered via staffOrderOpsTools)
// ---------------------------------------------------------------------------

const recordPaymentTool = {
  name: "record_payment",
  description: "Record a manual payment on an order — stamps paid_at, payment_method, and the " +
    "paid amount; no status change. Only allowed on approved, in_progress, or completed " +
    "orders. SENSITIVE — TOUCHES MONEY: never call this on a first-pass guess. First echo the " +
    'exact amount, method, and order to the human (e.g. "Record $180.00 cash on order #42 — ' +
    'confirm?") and only call after they confirm in this conversation, with confirmed: true.',
  schema: z.object({
    orderId: z.string().describe("The order ID (numeric string or number)"),
    amountCents: z
      .number()
      .int()
      .positive()
      .describe("Payment amount in CENTS (e.g. $180.00 → 18000)"),
    method: z
      .enum(PAYMENT_METHODS)
      .describe("How the customer paid"),
    reference: z
      .string()
      .optional()
      .describe("Optional reference (check number, Venmo handle, Stripe id, ...)"),
    paidAt: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp when the payment was received (defaults to now)"),
    confirmed: z
      .boolean()
      .describe(
        "Set true ONLY after the human has confirmed the echoed amount and method in this " +
          "conversation. Never set true on your own initiative.",
      ),
  }),
  execute: async (
    params: {
      orderId: string;
      amountCents: number;
      method: PaymentMethod;
      reference?: string;
      paidAt?: string;
      confirmed: boolean;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }
    // Confirmation fence (Codex C8) — pure input validation, checked before
    // any DB access so an unconfirmed call has zero side effects.
    if (params.confirmed !== true) {
      return toolResult({
        success: false,
        error: "record_payment requires explicit human confirmation. Echo the amount, method, " +
          "and order to the user, wait for their confirmation in this conversation, then " +
          "re-call with confirmed: true.",
      });
    }
    let paidAt: Date | undefined;
    if (params.paidAt) {
      paidAt = new Date(params.paidAt);
      if (Number.isNaN(paidAt.getTime())) {
        return toolResult({ success: false, error: "Invalid paidAt timestamp (use ISO 8601)" });
      }
    }
    // Ownership pre-flight (WRITE) — same rule as transition_order_status.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    const actor = customerAgentActor(ctx) ?? staffAgentActor(ctx);
    const result = await recordPayment(id, {
      amountCents: params.amountCents,
      method: params.method,
      reference: params.reference,
      paidAt,
    }, actor);
    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      paidAt: row.paidAt,
      paymentMethod: row.paymentMethod,
      paidAmountCents: row.paidAmountCents,
      message: `Payment of $${(params.amountCents / 100).toFixed(2)} (${params.method}) ` +
        `recorded on order #${row.id}`,
    }));
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

/** Staff-agent-only order operations. The customer agent must NEVER register
 *  these (dispatch + money). Belt-and-braces: even if misregistered, a
 *  customer ctx resolves to customer authority, which assignProvider /
 *  recordPayment reject at the harness layer. */
export const staffOrderOpsTools = [
  assignMechanicTool,
  recordPaymentTool,
];
