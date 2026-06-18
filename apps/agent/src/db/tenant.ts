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
