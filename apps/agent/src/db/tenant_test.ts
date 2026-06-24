// Pure unit tests for the tenant guard helpers (no DB). These lock in the two
// footguns: whereShop returns *undefined* (an unscoped query) for the owner
// all-shops sentinel, and canWrite must reject owner-all-shops + no-context.
import { assertEquals } from "@std/assert";
import { canWrite, OWNER_ALL_SHOPS, whereShop } from "./tenant.ts";
import { schema } from "./client.ts";

const SHOP = "11111111-1111-1111-1111-111111111111";

Deno.test("whereShop: concrete shop produces a predicate", () => {
  // Defined SQL => the query WILL be filtered by shop.
  assertEquals(whereShop(schema.orders.shopId, SHOP) !== undefined, true);
});

Deno.test("whereShop: owner all-shops sentinel produces NO predicate (unscoped)", () => {
  // undefined => Drizzle adds no WHERE clause => reads span every shop. This is
  // intentional for owner reads; the test pins the behavior so a refactor can't
  // silently turn it into a scoped (and thus empty) query or vice-versa.
  assertEquals(whereShop(schema.orders.shopId, OWNER_ALL_SHOPS), undefined);
});

Deno.test("canWrite: customer may always write", () => {
  assertEquals(canWrite({ customerId: 42 }), true);
  // customerId wins even if shopId is the all-shops sentinel.
  assertEquals(canWrite({ customerId: 42, shopId: OWNER_ALL_SHOPS }), true);
});

Deno.test("canWrite: staff with a concrete shop may write", () => {
  assertEquals(canWrite({ shopId: SHOP }), true);
});

Deno.test("canWrite: owner all-shops is read-only (no write)", () => {
  assertEquals(canWrite({ shopId: OWNER_ALL_SHOPS }), false);
});

Deno.test("canWrite: no context denies", () => {
  assertEquals(canWrite({}), false);
});
