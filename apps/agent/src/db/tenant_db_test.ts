// L2 — hits real Postgres. Skips if no DATABASE_URL.
import { assertEquals } from "@std/assert";
import { db, ordersForShop, schema } from "./client.ts";
import { eq } from "drizzle-orm";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const MARK = "[tenant-l2]";

Deno.test({
  name: "ordersForShop returns only the scoped shop's orders",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const [a] = await db.insert(schema.shops).values({
      name: `${MARK} A`,
      slug: `${MARK}-a-${crypto.randomUUID()}`,
    }).returning();
    const [b] = await db.insert(schema.shops).values({
      name: `${MARK} B`,
      slug: `${MARK}-b-${crypto.randomUUID()}`,
    }).returning();
    const [ca] = await db.insert(schema.customers).values({ name: `${MARK} ca`, shopId: a.id })
      .returning();
    const [cb] = await db.insert(schema.customers).values({ name: `${MARK} cb`, shopId: b.id })
      .returning();
    const [oa] = await db.insert(schema.orders).values({
      shopId: a.id,
      customerId: ca.id,
      shareToken: `${MARK}-oa-${crypto.randomUUID()}`,
    }).returning();
    const [ob] = await db.insert(schema.orders).values({
      shopId: b.id,
      customerId: cb.id,
      shareToken: `${MARK}-ob-${crypto.randomUUID()}`,
    }).returning();

    const aOrders = await ordersForShop(a.id);
    assertEquals(aOrders.some((o) => o.id === oa.id), true);
    assertEquals(aOrders.some((o) => o.id === ob.id), false);

    // Cleanup
    await db.delete(schema.orders).where(eq(schema.orders.id, oa.id));
    await db.delete(schema.orders).where(eq(schema.orders.id, ob.id));
    await db.delete(schema.customers).where(eq(schema.customers.id, ca.id));
    await db.delete(schema.customers).where(eq(schema.customers.id, cb.id));
    await db.delete(schema.shops).where(eq(schema.shops.id, a.id));
    await db.delete(schema.shops).where(eq(schema.shops.id, b.id));
  },
});
