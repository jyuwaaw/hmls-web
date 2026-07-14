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
  postalCode: "95113",
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
  assert(!partLookupInputSchema.safeParse({ ...validInput, postalCode: "95113-1234" }).success);
  assert(!partLookupInputSchema.safeParse({ ...validInput, streetAddress: "123 Main St" }).success);
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
            source: "web_search",
            engineVariant: "2.5L I4",
            partType: "oem",
            fitmentNote: "2.5L fitment",
            sourceTitle: "Toyota Parts",
            sourceUrl: "https://parts.example/oem",
            searchedAt: "2026-07-13T00:00:00.000Z",
          }],
        },
        retailerEntriesByItemId: {
          belt: [{
            kind: "search",
            retailer: "autozone",
            retailerLabel: "AutoZone",
            partName: "Serpentine Belt Replacement",
            engineVariant: "2.5L I4",
            searchTitle: "Search AutoZone",
            sourceUrl: "https://www.autozone.com/searchresult?searchText=90916-A2027",
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
    assertEquals(body.lookup.retailerFallbackCount, 1);
  } finally {
    Deno.env.delete("SKIP_AUTH");
  }
});

Deno.test("part lookup: returns fallback-only status when direct evidence is sparse", async () => {
  resetPartLookupCooldownForTests();
  Deno.env.set("SKIP_AUTH", "true");
  try {
    const router = createPartReferenceLookup(() =>
      Promise.resolve({
        referencesByItemId: {},
        retailerEntriesByItemId: {
          belt: [{
            kind: "search",
            retailer: "amazon",
            retailerLabel: "Amazon",
            partName: "Serpentine Belt Replacement",
            engineVariant: "Engine not verified",
            searchTitle: "Search Amazon",
            sourceUrl: "https://www.amazon.com/s?k=2018%20Toyota%20Camry%20belt",
          }],
        },
        emptyGroups: [],
        evidenceCount: 0,
        sourceCount: 0,
      })
    );
    const response = await router.request("/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).lookup.status, "fallback_only");
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

Deno.test("part lookup: sanitizes provider failures", async () => {
  resetPartLookupCooldownForTests();
  Deno.env.set("SKIP_AUTH", "true");
  try {
    const router = createPartReferenceLookup(() =>
      Promise.reject(new Error("secret provider response and credential metadata"))
    );
    const response = await router.request("/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    assertEquals(response.status, 502);
    assertEquals(await response.json(), {
      error: {
        code: "LOOKUP_FAILED",
        message: "Part-number lookup is temporarily unavailable",
      },
    });
  } finally {
    Deno.env.delete("SKIP_AUTH");
  }
});
