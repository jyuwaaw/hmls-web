import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db, schema, whereShop } from "@hmls/agent/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { type AdminEnv, requireAdmin } from "../middleware/admin.ts";
import { OWNER_ALL_SHOPS, requireShopContext, type WithShop } from "../middleware/shop-context.ts";
import {
  createCustomerInput,
  listCustomersQuery,
  updateCustomerInput,
} from "@hmls/shared/api/contracts/admin";
import type { CustomerRow, OrderRow, VehicleInfo } from "@hmls/shared/db/types";
import type { OrderStatus } from "@hmls/shared/order/status";

type ApiError = { error: { code: string; message: string } };

const admin = new Hono<WithShop<AdminEnv>>();

// All admin routes require admin role
admin.use("*", requireAdmin);
admin.use("*", requireShopContext);

// GET /shops — list shops visible to this admin.
// Owner sees all shops; admin sees only their own shop.
admin.get("/shops", async (c) => {
  const isOwner = c.get("isOwner");
  const shopId = c.get("shopId");
  const rows = isOwner
    ? await db
      .select({ id: schema.shops.id, name: schema.shops.name, slug: schema.shops.slug })
      .from(schema.shops)
    : await db
      .select({ id: schema.shops.id, name: schema.shops.name, slug: schema.shops.slug })
      .from(schema.shops)
      .where(eq(schema.shops.id, shopId));
  return c.json(rows);
});

// GET /me — lightweight role check (no DB). Used as the admin guard in the
// web DashboardLayout; keeps the heavy /dashboard query for the dashboard page
// alone instead of running it on every admin page.
admin.get("/me", (c) => {
  const user = c.get("authUser");
  return c.json<{ id: string; email: string | null; role: string | null }>(
    { id: user.id, email: user.email, role: user.role },
  );
});

// GET /dashboard — KPI stats
admin.get("/dashboard", async (c) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const shopId = c.get("shopId");

  const [
    [customerCount],
    [orderCount],
    upcomingBookings,
    recentCustomers,
  ] = await Promise.all([
    db.select({ count: count() }).from(schema.customers).where(
      whereShop(schema.customers.shopId, shopId),
    ),
    db.select({ count: count() }).from(schema.orders).where(
      whereShop(schema.orders.shopId, shopId),
    ),
    db
      .select()
      .from(schema.orders)
      .where(
        and(
          whereShop(schema.orders.shopId, shopId),
          gte(schema.orders.scheduledAt, now),
          sql`${schema.orders.status} IN ('scheduled', 'in_progress')`,
        ),
      )
      .orderBy(schema.orders.scheduledAt)
      .limit(5),
    db
      .select()
      .from(schema.customers)
      .where(whereShop(schema.customers.shopId, shopId))
      .orderBy(desc(schema.customers.createdAt))
      .limit(5),
  ]);

  // Revenue: actual paid amount on completed orders in last 30 days,
  // falling back to subtotal for orders that haven't been marked paid yet.
  const [revenueResult] = await db
    .select({
      total: sql<
        number
      >`COALESCE(SUM(COALESCE(${schema.orders.paidAmountCents}, ${schema.orders.subtotalCents})), 0)`,
    })
    .from(schema.orders)
    .where(
      and(
        whereShop(schema.orders.shopId, shopId),
        sql`${schema.orders.status} = 'completed' AND ${schema.orders.createdAt} >= ${thirtyDaysAgo.toISOString()}`,
      ),
    );

  const [pendingReview] = await db
    .select({ count: count() })
    .from(schema.orders)
    .where(and(whereShop(schema.orders.shopId, shopId), eq(schema.orders.status, "draft")));

  const [pendingApprovals] = await db
    .select({ count: count() })
    .from(schema.orders)
    .where(and(whereShop(schema.orders.shopId, shopId), eq(schema.orders.status, "estimated")));

  const [activeJobs] = await db
    .select({ count: count() })
    .from(schema.orders)
    .where(
      and(
        whereShop(schema.orders.shopId, shopId),
        sql`${schema.orders.status} IN ('approved', 'scheduled', 'in_progress')`,
      ),
    );

  return c.json<{
    stats: {
      customers: number;
      orders: number;
      pendingReview: number;
      pendingApprovals: number;
      activeJobs: number;
      revenue30d: number;
    };
    upcomingOrders: Array<{
      id: number;
      scheduledAt: Date | null;
      contactName: string | null;
      vehicleInfo: VehicleInfo | null;
      status: OrderStatus;
    }>;
    recentCustomers: CustomerRow[];
  }>({
    stats: {
      customers: customerCount.count,
      orders: orderCount.count,
      pendingReview: pendingReview.count,
      pendingApprovals: pendingApprovals.count,
      activeJobs: activeJobs.count,
      revenue30d: revenueResult.total,
    },
    upcomingOrders: upcomingBookings.map((o) => ({
      id: o.id,
      scheduledAt: o.scheduledAt,
      contactName: o.contactName,
      vehicleInfo: o.vehicleInfo as VehicleInfo | null,
      status: o.status as OrderStatus,
    })),
    recentCustomers,
  });
});

// GET /customers — all customers
admin.get("/customers", zValidator("query", listCustomersQuery), async (c) => {
  const { search } = c.req.valid("query");
  const shopId = c.get("shopId");
  let query = db
    .select()
    .from(schema.customers)
    .where(whereShop(schema.customers.shopId, shopId))
    .orderBy(desc(schema.customers.createdAt))
    .$dynamic();

  if (search) {
    query = query.where(
      and(
        whereShop(schema.customers.shopId, shopId),
        sql`(${schema.customers.name} ILIKE ${
          "%" + search + "%"
        } OR ${schema.customers.email} ILIKE ${
          "%" + search + "%"
        } OR ${schema.customers.phone} ILIKE ${"%" + search + "%"})`,
      ),
    );
  }

  const rows = await query.limit(100);
  return c.json<CustomerRow[]>(rows);
});

// GET /customers/:id — single customer with their orders
admin.get("/customers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid customer ID" } },
      400,
    );
  }

  const shopId = c.get("shopId");

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), whereShop(schema.customers.shopId, shopId)))
    .limit(1);

  if (!customer) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Customer not found" } }, 404);
  }

  const orders = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.customerId, id), whereShop(schema.orders.shopId, shopId)))
    .orderBy(desc(schema.orders.createdAt));

  return c.json<{ customer: CustomerRow; orders: OrderRow[] }>({ customer, orders });
});

// PATCH /customers/:id — update customer
admin.patch("/customers/:id", zValidator("json", updateCustomerInput), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid customer ID" } },
      400,
    );
  }

  const body = c.req.valid("json");
  const shopId = c.get("shopId");
  if (shopId === OWNER_ALL_SHOPS) {
    return c.json({ error: { code: "NO_SHOP", message: "Select a shop before writing" } }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (body.email !== undefined) updates.email = body.email;
  if (body.address !== undefined) updates.address = body.address;
  if (body.vehicleInfo !== undefined) updates.vehicleInfo = body.vehicleInfo;

  if (Object.keys(updates).length === 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "No fields to update" } },
      400,
    );
  }

  const [updated] = await db
    .update(schema.customers)
    .set(updates)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.shopId, shopId)))
    .returning();

  if (!updated) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Customer not found" } }, 404);
  }

  return c.json<CustomerRow>(updated);
});

// POST /customers — create customer
admin.post("/customers", zValidator("json", createCustomerInput), async (c) => {
  const body = c.req.valid("json");
  const shopId = c.get("shopId");
  if (shopId === OWNER_ALL_SHOPS) {
    return c.json({ error: { code: "NO_SHOP", message: "Select a shop before writing" } }, 400);
  }

  if (!body.name && !body.email && !body.phone) {
    return c.json<ApiError>({
      error: { code: "BAD_REQUEST", message: "At least one of name, email, or phone is required" },
    }, 400);
  }

  // Per-shop uniqueness: reject if this shop already has a customer with the
  // same email. Different shops may share emails (no global constraint).
  if (body.email) {
    const [dupe] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.email, body.email), eq(schema.customers.shopId, shopId)))
      .limit(1);
    if (dupe) {
      return c.json<ApiError>(
        {
          error: {
            code: "CONFLICT",
            message: "A customer with this email already exists in this shop",
          },
        },
        409,
      );
    }
  }

  const [customer] = await db
    .insert(schema.customers)
    .values({
      shopId,
      name: body.name ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      address: body.address ?? null,
      vehicleInfo: body.vehicleInfo ?? null,
      role: "customer",
    })
    .returning();

  return c.json<CustomerRow>(customer, 201);
});

// DELETE /customers/:id — delete customer
admin.delete("/customers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json<ApiError>(
      { error: { code: "BAD_REQUEST", message: "Invalid customer ID" } },
      400,
    );
  }

  const shopId = c.get("shopId");

  const [existing] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.shopId, shopId)))
    .limit(1);

  if (!existing) {
    return c.json<ApiError>({ error: { code: "NOT_FOUND", message: "Customer not found" } }, 404);
  }

  await db.delete(schema.customers).where(
    and(eq(schema.customers.id, id), eq(schema.customers.shopId, shopId)),
  );
  return c.json<{ success: true }>({ success: true });
});

export { admin };
