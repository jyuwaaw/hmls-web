import { describe, expect, it } from "bun:test";
import type { OrderItem, PartReference } from "@hmls/shared/db/schema";
import type {
  OnlinePartReference,
  RetailerEntry,
} from "@/lib/part-reference-cache";
import {
  collectOnlineReferenceParts,
  collectReferenceParts,
  collectRetailerEntries,
  groupOnlineReferenceParts,
} from "./TechPrepCard";

function item(referenceParts?: PartReference[]): OrderItem {
  return {
    id: "service-1",
    category: "labor",
    name: "Spark Plug Replacement",
    quantity: 1,
    unitPriceCents: 10000,
    totalCents: 10000,
    taxable: true,
    referenceParts,
  };
}

describe("collectReferenceParts", () => {
  it("returns no references for absent data", () => {
    expect(collectReferenceParts([item()])).toEqual([]);
  });

  it("collects an aftermarket reference and its related service", () => {
    expect(
      collectReferenceParts([
        item([
          {
            partName: "Spark plug",
            brand: "NGK",
            partNumber: "6619",
            source: "rockauto",
          },
        ]),
      ]),
    ).toEqual([
      {
        serviceId: "service-1",
        serviceName: "Spark Plug Replacement",
        partName: "Spark plug",
        brand: "NGK",
        partNumber: "6619",
        source: "rockauto",
      },
    ]);
  });

  it("preserves an explicit OEM cross-reference", () => {
    const [reference] = collectReferenceParts([
      item([
        {
          partName: "Spark plug",
          brand: "NGK",
          partNumber: "6619",
          source: "rockauto",
          oemPartNumber: "12290-R40-A02",
        },
      ]),
    ]);
    expect(reference.oemPartNumber).toBe("12290-R40-A02");
  });

  it("drops malformed values and de-duplicates within the same service", () => {
    const duplicate = {
      partName: "Spark plug",
      brand: "NGK",
      partNumber: "6619",
      source: "rockauto" as const,
    };
    const malformed = {
      partName: 123,
      brand: "",
      partNumber: "bad",
      source: "rockauto" as const,
    } as unknown as PartReference;

    expect(
      collectReferenceParts([
        item([duplicate, { ...duplicate, brand: "ngk" }, malformed]),
      ]),
    ).toHaveLength(1);
  });
});

describe("groupOnlineReferenceParts", () => {
  it("attaches service names, de-duplicates, and groups variants independently", () => {
    const online = (
      brand: string,
      partNumber: string,
      engineVariant: string,
    ): OnlinePartReference => ({
      partName: "Spark Plug Replacement",
      brand,
      partNumber,
      source: "web_search",
      engineVariant,
      partType: "aftermarket",
      fitmentNote: `${engineVariant} fitment`,
      sourceTitle: "Parts Catalog",
      sourceUrl: `https://parts.example/${partNumber}`,
      searchedAt: "2026-07-13T00:00:00.000Z",
    });
    const ngk = online("NGK", "6619", "1.6L I4");
    const references = collectOnlineReferenceParts([item()], {
      "service-1": [ngk, ngk, online("Denso", "4711", "1.8L I4")],
      unknown: [online("Ignored", "0000", "1.0L")],
    });

    expect(references).toHaveLength(2);
    expect(
      groupOnlineReferenceParts(references).map((group) => ({
        engineVariant: group.engineVariant,
        partNumbers: group.references.map((reference) => reference.partNumber),
      })),
    ).toEqual([
      { engineVariant: "1.6L I4", partNumbers: ["6619"] },
      { engineVariant: "1.8L I4", partNumbers: ["4711"] },
    ]);
  });

  it("groups verified offers and fallback searches with their engine variant", () => {
    const entries: RetailerEntry[] = [
      {
        kind: "offer",
        retailer: "autozone",
        retailerLabel: "AutoZone",
        partName: "Spark Plug Replacement",
        engineVariant: "1.6L I4",
        productTitle: "NGK Plug",
        brand: "NGK",
        partNumber: "6619",
        fitmentNote: "1.6L fitment",
        priceCents: 899,
        rating: null,
        sourceTitle: "AutoZone",
        sourceUrl: "https://www.autozone.com/p/6619",
        searchedAt: "2026-07-13T00:00:00.000Z",
      },
      {
        kind: "search",
        retailer: "amazon",
        retailerLabel: "Amazon",
        partName: "Spark Plug Replacement",
        engineVariant: "Engine not verified",
        searchTitle: "Search Amazon",
        sourceUrl: "https://www.amazon.com/s?k=NGK+6619",
      },
    ];
    const collected = collectRetailerEntries([item()], {
      "service-1": entries,
    });
    const groups = groupOnlineReferenceParts([], collected);
    expect(
      groups.map((group) => ({
        engineVariant: group.engineVariant,
        kinds: group.retailerEntries.map((entry) => entry.kind),
      })),
    ).toEqual([
      { engineVariant: "1.6L I4", kinds: ["offer"] },
      { engineVariant: "Engine not verified", kinds: ["search"] },
    ]);
  });
});
