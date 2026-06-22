import { z } from "zod";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db, schema, scoped, whereShop } from "../../db/client.ts";
import { type AccessCtx, canWrite, orderAccessible } from "../../db/tenant.ts";
import type { OrderItem } from "@hmls/shared/db/schema";
import { EDITABLE_STATUSES, isOrderStatus } from "@hmls/shared/order/status";
import { toolResult } from "@hmls/shared/tool-result";
import type { LaborTimeResult, OlpVehicle } from "./olp-client.ts";
import type { ToolContext } from "../../common/convert-tools.ts";
import { addNote, patchItems } from "../../services/order-state.ts";
import { staffAgentActor, toolResultFromOrderState } from "../../services/order-state-tool.ts";

// Note: `create_order` lives in apps/agent/src/common/tools/order.ts — it's the
// only entry point for new orders (full pricing engine, INSERT-or-UPDATE-by-orderId).
// Tools below are read/incremental-update helpers that complement it.

// ---------------------------------------------------------------------------
// Tool 1: list_orders
// ---------------------------------------------------------------------------

const listOrdersTool = {
  name: "list_orders",
  description: "List all orders with optional status filter. Returns id, status, customer name, " +
    "vehicle info, total, and created date. Use to browse the order queue or find orders " +
    "by status (e.g. 'draft', 'estimated', 'in_progress').",
  schema: z.object({
    status: z
      .string()
      .optional()
      .describe(
        "Filter by order status (e.g. 'draft', 'estimated', 'approved', 'in_progress'). Omit to list all.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Max number of orders to return (default 50, max 100)"),
  }),
  execute: async (
    params: { status?: string; limit?: number },
    ctx: ToolContext | undefined,
  ) => {
    const limit = Math.min(params.limit ?? 50, 100);
    const shopId = ctx?.shopId;

    let query = db
      .select()
      .from(schema.orders)
      .orderBy(desc(schema.orders.createdAt))
      .$dynamic();

    if (params.status) {
      // Narrow the agent-supplied string against the canonical enum before
      // querying so we never attempt `WHERE status = 'banana'`.
      if (!isOrderStatus(params.status)) {
        return toolResult({
          success: false,
          error: `Invalid status filter: ${params.status}. Valid values: draft, estimated, ` +
            `revised, approved, declined, scheduled, in_progress, completed, cancelled.`,
        });
      }
      // Combine shop scope with status filter.
      const shopFilter = shopId ? whereShop(schema.orders.shopId, shopId) : undefined;
      const statusFilter = eq(schema.orders.status, params.status);
      query = query.where(and(shopFilter, statusFilter));
    } else if (shopId) {
      query = query.where(whereShop(schema.orders.shopId, shopId));
    }

    const rows = await query.limit(limit);

    const orders = rows.map((o) => ({
      id: o.id,
      status: o.status,
      customerName: o.contactName ?? null,
      vehicleInfo: o.vehicleInfo
        ? (() => {
          const v = o.vehicleInfo as { year?: string; make?: string; model?: string };
          return [v.year, v.make, v.model].filter(Boolean).join(" ") || null;
        })()
        : null,
      subtotalFormatted: `$${((o.subtotalCents ?? 0) / 100).toFixed(2)}`,
      subtotalCents: o.subtotalCents ?? 0,
      createdAt: o.createdAt,
    }));

    return toolResult({
      success: true,
      total: orders.length,
      orders,
    });
  },
};

// ---------------------------------------------------------------------------
// Tool 2: search_customers
// ---------------------------------------------------------------------------

const searchCustomersTool = {
  name: "search_customers",
  description: "Find customers by name, email, or phone number. Returns matching customers with " +
    "id, name, email, phone, and address. Use before create_order to look up an existing " +
    "customerId (avoids creating a duplicate guest customer).",
  schema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Search term — matches against customer name, email, or phone"),
  }),
  execute: async (params: { query: string }, ctx: ToolContext | undefined) => {
    const term = `%${params.query}%`;
    const shopId = ctx?.shopId;

    const searchFilter = or(
      ilike(schema.customers.name, term),
      ilike(schema.customers.email, term),
      ilike(schema.customers.phone, term),
    );

    const rows = await db
      .select()
      .from(schema.customers)
      .where(shopId ? scoped(schema.customers.shopId, shopId, searchFilter) : searchFilter)
      .orderBy(desc(schema.customers.createdAt))
      .limit(20);

    const customers = rows.map((c) => ({
      id: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      address: c.address ?? null,
      vehicleInfo: c.vehicleInfo ?? null,
      createdAt: c.createdAt,
    }));

    return toolResult({
      success: true,
      total: customers.length,
      customers,
    });
  },
};

// ---------------------------------------------------------------------------
// Tool 3: update_order_items -- PATCH mode with stable item IDs
// ---------------------------------------------------------------------------

// In-memory idempotency set. Narrow purpose: dedupe tool-call retries in a
// single process. Optimistic concurrency across processes is handled by
// patchItems via revisionNumber.
const executedKeys = new Set<string>();

const updateOrderItemsTool = {
  name: "update_order_items",
  description: "Update line items on a draft, revised, or estimated order using PATCH semantics. " +
    "Only works on orders in 'draft', 'revised', or 'estimated' status. " +
    "Operations: add new items, update existing by itemId, or remove by itemId. " +
    "Use idempotencyKey to prevent duplicate operations on retry. " +
    "ExpectedVersion ensures no concurrent-overwrite conflicts.",
  schema: z.object({
    order_id: z
      .string()
      .describe("The order ID to update (numeric string or number)"),
    // PATCH operations
    addItems: z
      .array(
        z.object({
          itemId: z
            .string()
            .optional()
            .describe("Optional stable item ID. Auto-generated if omitted."),
          description: z
            .string()
            .describe("Line item description (e.g., 'Front brake pad replacement')"),
          labor_hours: z
            .number()
            .optional()
            .describe("Labor hours (optional — auto-lookup if omitted and vehicle known)"),
          parts_cost: z
            .number()
            .optional()
            .describe("Parts cost in dollars (optional — defaults to $0)"),
          intent: z
            .enum(["replace", "inspect", "optional", "note"])
            .default("replace")
            .describe("Service intent: replace=正式施工, inspect=检查, optional=可选项, note=备注"),
        }),
      )
      .optional()
      .describe("Items to add to the order"),
    updateItems: z
      .array(
        z.object({
          itemId: z.string().describe("Existing item ID to update"),
          description: z.string().optional().describe("New description"),
          labor_hours: z.number().optional().describe("New labor hours"),
          parts_cost: z.number().optional().describe("New parts cost"),
          intent: z
            .enum(["replace", "inspect", "optional", "note"])
            .optional()
            .describe("New service intent"),
        }),
      )
      .optional()
      .describe("Items to update by itemId"),
    removeItemIds: z
      .array(z.string())
      .optional()
      .describe("Item IDs to remove from the order"),
    // Safety
    expectedVersion: z
      .number()
      .int()
      .optional()
      .describe("Expected revisionNumber for optimistic concurrency (optional)"),
    idempotencyKey: z
      .string()
      .optional()
      .describe("Unique key to prevent duplicate execution (e.g., 'req-123')"),
    notes: z
      .string()
      .optional()
      .describe("Updated notes for the order"),
  }),
  execute: async (
    params: {
      order_id: string;
      addItems?: Array<{
        itemId?: string;
        description: string;
        labor_hours?: number;
        parts_cost?: number;
        intent?: "replace" | "inspect" | "optional" | "note";
      }>;
      updateItems?: Array<{
        itemId: string;
        description?: string;
        labor_hours?: number;
        parts_cost?: number;
        intent?: "replace" | "inspect" | "optional" | "note";
      }>;
      removeItemIds?: string[];
      expectedVersion?: number;
      idempotencyKey?: string;
      notes?: string;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.order_id);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order_id" });
    }

    // Ownership pre-flight (WRITE). Staff may only edit their own shop's
    // order; owner-no-shop is read-only (rejected). Mirror the existing
    // "not found" shape so existence isn't leaked.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    if (params.idempotencyKey && executedKeys.has(params.idempotencyKey)) {
      return toolResult({
        success: true,
        orderId: id,
        message: "Already processed (idempotency hit)",
        deduplicated: true,
      });
    }

    if (
      params.addItems === undefined &&
      params.updateItems === undefined &&
      params.removeItemIds === undefined &&
      params.notes === undefined
    ) {
      return toolResult({
        success: false,
        error: "Provide at least one of: addItems, updateItems, removeItemIds, notes",
      });
    }

    // Read current items + vehicle info to drive OLP labor lookups and PATCH
    // semantics. The harness re-reads for its own optimistic lock; this SELECT
    // is for the tool's domain logic (item building, not concurrency).
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) return toolResult({ success: false, error: `Order #${id} not found` });
    if (!isOrderStatus(order.status) || !EDITABLE_STATUSES.has(order.status)) {
      return toolResult({
        success: false,
        error:
          `Cannot edit order #${id} in '${order.status}' status. Editable statuses: draft, revised, estimated`,
      });
    }

    const existingItems: OrderItem[] = Array.isArray(order.items)
      ? (order.items as OrderItem[])
      : [];
    const itemsMap = new Map<string, OrderItem>(existingItems.map((i) => [i.id, i]));
    const vehicleInfo =
      (order as unknown as { vehicleInfo?: { year?: string; make?: string; model?: string } })
        .vehicleInfo;

    async function buildItem(
      desc: string,
      laborHours?: number,
      partsCost?: number,
      intent: "replace" | "inspect" | "optional" | "note" = "replace",
      stableId?: string,
      sourceMeta?: LaborTimeResult["sourceMeta"],
    ): Promise<OrderItem> {
      let finalLabor = laborHours ?? 0;
      let resolvedSourceMeta = sourceMeta;

      if (finalLabor === 0 && vehicleInfo?.year && vehicleInfo?.make && vehicleInfo?.model) {
        try {
          const { searchLaborTimes, findVehicles } = await import("./olp-client.ts");
          const vehicles = await findVehicles(
            vehicleInfo.make,
            vehicleInfo.model,
            Number(vehicleInfo.year),
          );
          if (vehicles.length > 0) {
            const serviceWords = desc.split(/\s+/).filter((w) => w.length > 1);
            const laborTimes = await searchLaborTimes(
              vehicles.map((v: OlpVehicle) => v.id),
              serviceWords,
              undefined,
            );
            if (laborTimes.length > 0) {
              finalLabor = Number(laborTimes[0].labor_hours);
              resolvedSourceMeta = laborTimes[0].sourceMeta;
            }
          }
        } catch (_e) {
          // Keep defaults; shop prices manually on review.
        }
      }

      const laborCents = Math.round(finalLabor * 140 * 100);
      const partsCents = Math.round((partsCost ?? 0) * 100);
      const totalCents = laborCents + partsCents;

      const metadata: Record<string, unknown> = {};
      if (intent) metadata.intent = intent;
      if (resolvedSourceMeta) metadata.sourceMeta = resolvedSourceMeta;

      return {
        id: stableId ?? crypto.randomUUID(),
        category: intent === "note" ? "fee" : "labor",
        name: desc,
        quantity: 1,
        unitPriceCents: totalCents,
        totalCents,
        taxable: intent !== "note",
        ...(finalLabor > 0 ? { laborHours: finalLabor } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }

    if (params.removeItemIds && params.removeItemIds.length > 0) {
      for (const rid of params.removeItemIds) itemsMap.delete(rid);
    }

    if (params.updateItems && params.updateItems.length > 0) {
      for (const upd of params.updateItems) {
        const existing = itemsMap.get(upd.itemId);
        if (!existing) {
          return toolResult({ success: false, error: `Item ${upd.itemId} not found` });
        }
        const existingLaborHours = (existing as unknown as { laborHours?: number }).laborHours ?? 0;
        const existingLaborCents = Math.round(existingLaborHours * 140 * 100);
        const existingPartsCents = Math.max(0, existing.totalCents - existingLaborCents);
        const existingPartsCost = existingPartsCents / 100;
        const rebuilt = await buildItem(
          upd.description ?? existing.name,
          upd.labor_hours ?? existingLaborHours,
          upd.parts_cost ?? existingPartsCost,
          upd.intent ??
            (existing as unknown as { metadata?: { intent?: string } }).metadata?.intent as
              | "replace"
              | "inspect"
              | "optional"
              | "note" ??
            "replace",
          upd.itemId,
        );
        itemsMap.set(upd.itemId, rebuilt);
      }
    }

    if (params.addItems && params.addItems.length > 0) {
      for (const add of params.addItems) {
        const newItem = await buildItem(
          add.description,
          add.labor_hours,
          add.parts_cost,
          add.intent ?? "replace",
          add.itemId,
        );
        itemsMap.set(newItem.id, newItem);
      }
    }

    const finalItems = Array.from(itemsMap.values());
    const actor = staffAgentActor(ctx);
    const result = await patchItems(
      id,
      {
        items: finalItems,
        notes: params.notes,
      },
      actor,
      {
        expectedVersion: params.expectedVersion,
        metadata: {
          added: params.addItems?.map((i) => i.description) ?? [],
          updated: params.updateItems?.map((i) => i.itemId) ?? [],
          removed: params.removeItemIds ?? [],
        },
      },
    );

    if (result.ok && params.idempotencyKey) {
      executedKeys.add(params.idempotencyKey);
    }

    return toolResultFromOrderState(result, (row) => ({
      orderId: row.id,
      status: row.status,
      version: row.revisionNumber,
      subtotalFormatted: `$${((row.subtotalCents ?? 0) / 100).toFixed(2)}`,
      itemCount: finalItems.length,
      notes: row.notes,
      message: `Order #${id} updated`,
    }));
  },
};

// ---------------------------------------------------------------------------
// Tool 4: update_order -- generic order metadata update
// ---------------------------------------------------------------------------

const updateOrderTool = {
  name: "update_order",
  description: "Update order metadata: customer info, vehicle info, notes. " +
    "Use this when customer provides their name/phone/email/vin AFTER order was created. " +
    "Supports partial updates — only include fields you want to change. " +
    "Does NOT change items or pricing.",
  schema: z.object({
    order_id: z.string().describe("The order ID to update"),
    customerInfo: z
      .object({
        name: z.string().optional().describe("Customer full name"),
        phone: z.string().optional().describe("Phone number"),
        email: z.string().email().optional().describe("Email address"),
        address: z.string().optional().describe("Street address"),
      })
      .optional()
      .describe("Customer contact information to update"),
    vehicleInfo: z
      .object({
        year: z
          .number()
          .int()
          .min(1900)
          .max(2030)
          .optional()
          .describe("Vehicle year (e.g., 2019)"),
        make: z.string().optional().describe("Vehicle make (e.g., 'Ford')"),
        model: z.string().optional().describe("Vehicle model (e.g., 'F-150')"),
        engine: z.string().optional().describe("Engine description (e.g., '5.0L V8')"),
        vin: z
          .string()
          .length(17)
          .regex(/^[A-HJ-NPR-Z0-9]{17}$/)
          .optional()
          .describe("VIN (17 chars, no I/O/Q)"),
        licensePlate: z.string().optional().describe("License plate number"),
        mileage: z.number().int().optional().describe("Current odometer reading"),
      })
      .optional()
      .describe("Vehicle information to update"),
    notes: z.string().optional().describe("Order notes"),
    expectedVersion: z.number().int().optional().describe(
      "Expected revisionNumber for optimistic concurrency",
    ),
    idempotencyKey: z.string().optional().describe("Idempotency key"),
  }),
  execute: async (
    params: {
      order_id: string;
      customerInfo?: { name?: string; phone?: string; email?: string; address?: string };
      vehicleInfo?: {
        year?: number;
        make?: string;
        model?: string;
        engine?: string;
        vin?: string;
        licensePlate?: string;
        mileage?: number;
      };
      notes?: string;
      expectedVersion?: number;
      idempotencyKey?: string;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.order_id);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order_id" });
    }

    // Ownership pre-flight (WRITE) — same rule as update_order_items.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    if (
      params.customerInfo === undefined &&
      params.vehicleInfo === undefined &&
      params.notes === undefined
    ) {
      return toolResult({
        success: false,
        error: "Provide at least one of: customerInfo, vehicleInfo, notes",
      });
    }

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);

    if (!order) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    // revisionNumber is owned by patchItems for items+pricing optimistic
    // concurrency. Metadata updates (contact / vehicle / notes) don't touch
    // it — bumping here only causes spurious conflicts on the next item
    // edit.
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (params.customerInfo !== undefined) {
      if (params.customerInfo.name !== undefined) updates.contactName = params.customerInfo.name;
      if (params.customerInfo.phone !== undefined) updates.contactPhone = params.customerInfo.phone;
      if (params.customerInfo.email !== undefined) updates.contactEmail = params.customerInfo.email;
      if (params.customerInfo.address !== undefined) {
        updates.contactAddress = params.customerInfo.address;
      }
    }

    if (params.vehicleInfo !== undefined) {
      const existingVehicle =
        (order as unknown as { vehicleInfo?: Record<string, unknown> }).vehicleInfo ?? {};
      updates.vehicleInfo = {
        ...existingVehicle,
        ...params.vehicleInfo,
        year: params.vehicleInfo.year
          ? String(params.vehicleInfo.year)
          : (existingVehicle.year as string | undefined),
        vin: params.vehicleInfo.vin?.toUpperCase() ?? (existingVehicle.vin as string | undefined),
      };
    }

    if (params.notes !== undefined) {
      updates.notes = params.notes;
    }

    // Metadata update — no status or revisionNumber guard needed. Contact
    // snapshot and vehicleInfo are editable at any status.
    const [updated] = await db
      .update(schema.orders)
      .set(updates)
      .where(eq(schema.orders.id, id))
      .returning();

    if (!updated) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    // Audit via the harness's addNote so the actor string stays consistent
    // with lifecycle events. The note summarizes which metadata fields
    // changed; structured detail lives in the harness's event metadata.
    const updatedFields = Object.keys(updates).filter((k) => k !== "updatedAt");
    await addNote(
      id,
      `Metadata updated: ${updatedFields.join(", ")}`,
      staffAgentActor(ctx),
    );

    const vehicle =
      (updated as unknown as { vehicleInfo?: { year?: string; make?: string; model?: string } })
        .vehicleInfo;
    return toolResult({
      success: true,
      orderId: updated.id,
      contactName: updated.contactName,
      contactPhone: updated.contactPhone,
      contactEmail: updated.contactEmail,
      vehicle: vehicle
        ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")
        : null,
      message: `Order #${id} updated`,
    });
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const adminOrderTools = [
  listOrdersTool,
  searchCustomersTool,
  updateOrderItemsTool,
  updateOrderTool,
];
