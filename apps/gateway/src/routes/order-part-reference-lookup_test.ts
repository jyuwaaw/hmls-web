import { assert, assertEquals } from "@std/assert";
import {
  createPartReferenceLookup,
  partLookupInputSchema,
  partReferenceLookup,
  resetPartLookupCooldownForTests,
} from "./order-part-reference-lookup.ts";

const validInput = {
  vehicle: { year: "2018", make: "Toyota", model: "Camry" },
  services: [{ itemId: "belt", name: "Serpentine Belt Replacement" }],
};

Deno.test("part lookup: rejects a missing Authorization header", async () => {
  const response = await partReferenceLookup.request("/lookup", { method: "POST" });
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error.code, "UNAUTHORIZED");
});

Deno.test("partLookupInputSchema rejects order and customer data", () => {
  assert(partLookupInputSchema.safeParse(validInput).success);
  assert(!partLookupInputSchema.safeParse({ ...validInput, orderId: 554 }).success);
  assert(!partLookupInputSchema.safeParse({ ...validInput, customerName: "Private" }).success);
  assert(!partLookupInputSchema.safeParse({ ...validInput, services: [] }).success);
});

Deno.test("part lookup: returns stateless research results", async () => {
  resetPartLookupCooldownForTests();
  Deno.env.set("SKIP_AUTH", "true");
  try {
    const router = createPartReferenceLookup((input) => {
      assertEquals(input, validInput);
      return Promise.resolve({
        referencesByItemId: {
          belt: [{
            partName: "Serpentine Belt Replacement",
            brand: "Toyota",
            partNumber: "90916-A2027",
            source: "google_search",
            engineVariant: "2.5L I4",
            partType: "oem",
            fitmentNote: "2.5L fitment",
            sourceTitle: "Toyota Parts",
            sourceUrl: "https://parts.example/oem",
            searchedAt: "2026-07-13T00:00:00.000Z",
          }],
        },
        emptyGroups: [],
        evidenceCount: 1,
        sourceCount: 1,
      });
    });
    const response = await router.request("/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.lookup.status, "found");
    assertEquals(body.referencesByItemId.belt[0].partNumber, "90916-A2027");
  } finally {
    Deno.env.delete("SKIP_AUTH");
  }
});

Deno.test("part lookup route has no HMLS database dependency", async () => {
  const source = await Deno.readTextFile(
    new URL("./order-part-reference-lookup.ts", import.meta.url),
  );
  assert(!source.includes("@hmls/agent/db"));
  assert(!source.includes("schema.orders"));
  assert(!source.includes("dbAdmin"));
});
