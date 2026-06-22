import { assertEquals } from "@std/assert";
import { OWNER_ALL_SHOPS, pickShopId } from "./shop-context.ts";

const SJ = "11111111-1111-1111-1111-111111111111";
const OC = "22222222-2222-2222-2222-222222222222";

Deno.test("pickShopId: admin uses home shop, ignores header", () => {
  assertEquals(
    pickShopId({ role: "admin", homeShopId: SJ, headerShopId: OC, validShopIds: [SJ, OC] }),
    { shopId: SJ, isOwner: false },
  );
});

Deno.test("pickShopId: admin with no home shop is an error", () => {
  assertEquals(
    pickShopId({ role: "admin", homeShopId: null, headerShopId: null, validShopIds: [SJ] }),
    { error: "NO_SHOP" },
  );
});

Deno.test("pickShopId: owner with valid header scopes to it", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: OC, validShopIds: [SJ, OC] }),
    { shopId: OC, isOwner: true },
  );
});

Deno.test("pickShopId: owner with no header => all-shops sentinel", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: null, validShopIds: [SJ, OC] }),
    { shopId: OWNER_ALL_SHOPS, isOwner: true },
  );
});

Deno.test("pickShopId: owner with bogus header is an error", () => {
  assertEquals(
    pickShopId({ role: "owner", homeShopId: null, headerShopId: "nope", validShopIds: [SJ, OC] }),
    { error: "BAD_SHOP" },
  );
});
