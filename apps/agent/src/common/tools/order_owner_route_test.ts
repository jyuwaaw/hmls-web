// L2 — hits real Postgres. Skips if no DATABASE_URL.
// Regression guard: an owner with NO shop selected (OWNER_ALL_SHOPS) must be
// able to create_order — the order routes to the shop nearest the service
// address, not blocked. (Was blocked by canWrite before the owner-all fix.)
import { assertEquals } from "@std/assert";
import { createOrderTool } from "./order.ts";
import { OWNER_ALL_SHOPS } from "../../db/tenant.ts";
import { dbAdmin, schema } from "../../db/client.ts";
import { eq, like } from "drizzle-orm";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const MARK = "[owner-route-l2]";

Deno.test({
  name: "owner-all create_order routes by address instead of blocking",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Ensure both shops carry coords + radius so nearestShop can route.
    const shops = [
      { slug: "san-jose", lat: "37.3361663", lng: "-121.8905910" },
      { slug: "orange-county", lat: "33.6484505", lng: "-117.8365716" },
    ];
    for (const s of shops) {
      await dbAdmin.update(schema.shops)
        .set({ latitude: s.lat, longitude: s.lng, serviceRadiusKm: 80 })
        .where(eq(schema.shops.slug, s.slug));
    }

    // Owner, no shop selected. Order address is in Orange County (Irvine).
    const ctx = { adminEmail: "owner@hmls.local", shopId: OWNER_ALL_SHOPS };
    const params = {
      customerInfo: {
        name: `${MARK} walkin`,
        phone: "9995550000",
        address: "1 Civic Center Plaza, Irvine, CA 92606",
      },
      vehicle: { make: "Honda", model: "Civic", year: 2020 },
      services: [{ name: "Oil change", description: "Standard", laborHours: 0.5 }],
    };

    // toolResult returns the payload object as-is (no MCP content wrapper).
    const out = await createOrderTool.execute(params, ctx) as {
      success?: boolean;
      action?: string;
      orderId?: number;
    };
    try {
      assertEquals(out.success, true); // not blocked
      assertEquals(out.action, "created");
      // Routed to the OC shop by the Irvine address.
      const [order] = await dbAdmin
        .select({ id: schema.orders.id, shopId: schema.orders.shopId })
        .from(schema.orders).where(eq(schema.orders.id, out.orderId!)).limit(1);
      const [ocShop] = await dbAdmin
        .select({ id: schema.shops.id }).from(schema.shops)
        .where(eq(schema.shops.slug, "orange-county")).limit(1);
      assertEquals(order.shopId, ocShop.id);
    } finally {
      // Delete matching customers' orders first (FK), then the customers.
      const custs = await dbAdmin.select({ id: schema.customers.id })
        .from(schema.customers).where(like(schema.customers.name, `${MARK}%`));
      for (const c of custs) {
        await dbAdmin.delete(schema.orders).where(eq(schema.orders.customerId, c.id));
      }
      await dbAdmin.delete(schema.customers).where(like(schema.customers.name, `${MARK}%`));
    }
  },
});
