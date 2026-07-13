import { describe, expect, it } from "bun:test";
import type { OrderItem, PartReference } from "@hmls/shared/db/schema";
import type { OnlinePartReference } from "@/lib/part-reference-cache";
import {
  collectOnlineReferenceParts,
  collectReferenceParts,
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
      source: "google_search",
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
});
