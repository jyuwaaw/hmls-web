import { and, eq, type SQL } from "drizzle-orm";
import { db, schema } from "./client.ts";

/** Mirror of the gateway sentinel (owner, no shop selected). Keep in sync with
 *  OWNER_ALL_SHOPS in apps/gateway/src/middleware/shop-context.ts. */
export const OWNER_ALL_SHOPS = "__all__";

/**
 * shop predicate for a tenant table column. Returns undefined for the
 * owner all-shops sentinel (caller must only reach this from read-only paths).
 */
export function whereShop(
  // deno-lint-ignore no-explicit-any
  column: any,
  shopId: string,
): SQL | undefined {
  return shopId === OWNER_ALL_SHOPS ? undefined : eq(column, shopId);
}

/** Combine a shop scope with extra conditions. */
export function scoped(
  // deno-lint-ignore no-explicit-any
  column: any,
  shopId: string,
  ...extra: (SQL | undefined)[]
): SQL | undefined {
  return and(whereShop(column, shopId), ...extra);
}

export interface AccessCtx {
  shopId?: string;
  customerId?: number;
}

/** True iff the order exists AND the caller may access it under the access rule.
 *  - customer (ctx.customerId set): only their own orders, across any shop
 *  - owner all-shops (ctx.shopId === OWNER_ALL_SHOPS): may read any order
 *  - staff (concrete ctx.shopId): only orders in their shop
 *  - no context: deny */
export async function orderAccessible(orderId: number, ctx: AccessCtx): Promise<boolean> {
  const [o] = await db
    .select({ shopId: schema.orders.shopId, customerId: schema.orders.customerId })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!o) return false;
  if (ctx.customerId != null) return o.customerId === ctx.customerId; // customer: own orders
  if (ctx.shopId === OWNER_ALL_SHOPS) return true; // owner: read any
  if (ctx.shopId) return o.shopId === ctx.shopId; // staff: own shop
  return false; // no context: deny
}

/** Writes are forbidden for an owner with no shop selected (and for no-context). */
export function canWrite(ctx: AccessCtx): boolean {
  if (ctx.customerId != null) return true;
  return !!ctx.shopId && ctx.shopId !== OWNER_ALL_SHOPS;
}

/** List orders for a shop (status optional). */
export function ordersForShop(shopId: string, status?: string) {
  return db.select().from(schema.orders).where(
    status
      ? scoped(
        schema.orders.shopId,
        shopId,
        // deno-lint-ignore no-explicit-any
        eq(schema.orders.status, status as any),
      )
      : whereShop(schema.orders.shopId, shopId),
  );
}
