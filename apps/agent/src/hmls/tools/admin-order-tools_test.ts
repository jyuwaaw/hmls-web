import { assertEquals } from "@std/assert";
import type { OrderItem } from "@hmls/shared/db/schema";
import { mergeItemUpdate } from "./admin-order-tools.ts";

// A parts line item, like the "Porsche C20 0w-20" oil from the bug report.
const partsItem: OrderItem = {
  id: "abc",
  category: "parts",
  name: "Porsche C20 0w-20",
  description: "synthetic, 6 qt",
  quantity: 1,
  unitPriceCents: 9000,
  totalCents: 9000,
  taxable: true,
  partNumber: "PN-123",
};

// A labor item priced at 1.8 hrs * $140 = $252.
const laborItem: OrderItem = {
  id: "l1",
  category: "labor",
  name: "Front brake pads",
  description: "OEM pads",
  quantity: 1,
  unitPriceCents: 25200,
  totalCents: 25200,
  taxable: true,
  laborHours: 1.8,
};

Deno.test("mergeItemUpdate: clearing description keeps name, price, and other fields", () => {
  // The exact bug: 'clear the description of Porsche C20 0w-20'.
  const out = mergeItemUpdate(partsItem, { description: "" });
  assertEquals(out.description, undefined); // cleared
  assertEquals(out.name, "Porsche C20 0w-20"); // NOT wiped (the old "" -> name footgun)
  assertEquals(out.totalCents, 9000); // no silent re-price
  assertEquals(out.partNumber, "PN-123"); // unrelated field preserved
  assertEquals(out.id, "abc");
});

Deno.test("mergeItemUpdate: renaming keeps the description", () => {
  const out = mergeItemUpdate(partsItem, { name: "Mobil 1 0w-20" });
  assertEquals(out.name, "Mobil 1 0w-20");
  assertEquals(out.description, "synthetic, 6 qt"); // old rebuild dropped this
  assertEquals(out.totalCents, 9000);
});

Deno.test("mergeItemUpdate: setting a new description does not touch name/price", () => {
  const out = mergeItemUpdate(partsItem, { description: "full synthetic" });
  assertEquals(out.description, "full synthetic");
  assertEquals(out.name, "Porsche C20 0w-20");
  assertEquals(out.totalCents, 9000);
});

Deno.test("mergeItemUpdate: never re-prices — price is create_order's job", () => {
  // update_order_items must not touch money. Editing label/description/intent
  // leaves totalCents untouched, including on a negative discount line (the
  // old re-price path would have flipped a credit into a charge).
  const discount: OrderItem = {
    id: "d1",
    category: "discount",
    name: "Loyalty credit",
    quantity: 1,
    unitPriceCents: -5000,
    totalCents: -5000,
    taxable: false,
  };
  const renamed = mergeItemUpdate(laborItem, { name: "Rear brake pads" });
  assertEquals(renamed.totalCents, 25200); // unchanged
  const discounted = mergeItemUpdate(discount, { description: "Q3 promo" });
  assertEquals(discounted.totalCents, -5000); // still a credit, not flipped
});

Deno.test("mergeItemUpdate: empty update is a no-op (identity)", () => {
  assertEquals(mergeItemUpdate(partsItem, {}), partsItem);
});
