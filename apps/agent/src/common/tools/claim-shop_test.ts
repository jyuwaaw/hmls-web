import { assertEquals } from "@std/assert";
import { shouldClaimShop } from "./claim-shop.ts";

Deno.test("shouldClaimShop: no prior orders + different shop -> true", () => {
  assertEquals(shouldClaimShop(false, "shop-a", "shop-b"), true);
});

Deno.test("shouldClaimShop: has prior orders -> false", () => {
  assertEquals(shouldClaimShop(true, "shop-a", "shop-b"), false);
});

Deno.test("shouldClaimShop: same shop -> false", () => {
  assertEquals(shouldClaimShop(false, "shop-a", "shop-a"), false);
});
