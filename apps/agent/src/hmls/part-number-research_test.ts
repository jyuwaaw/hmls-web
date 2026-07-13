import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildEvidenceBlocks,
  buildExtractionPrompt,
  buildSearchPrompt,
  normalizePartResearch,
  type PartResearchInput,
  researchPartNumbers,
} from "./part-number-research.ts";

const input: PartResearchInput = {
  vehicle: { year: "2018", make: "Toyota", model: "Camry" },
  services: [{ itemId: "belt", name: "Serpentine Belt Replacement" }],
};

const metadata = {
  groundingChunks: [
    { web: { uri: "https://parts.example/oem", title: "Toyota Parts" } },
    { web: { uri: "http://unsafe.example/belt", title: "Unsafe" } },
    { web: { uri: "https://parts.example/gates", title: "Gates Catalog" } },
  ],
  groundingSupports: [
    {
      segment: { text: "2.5L OEM belt 90916-A2027" },
      groundingChunkIndices: [0, 1],
    },
    {
      segment_text: "2.5L aftermarket Gates K060615",
      supportChunkIndices: [2],
    },
  ],
};

Deno.test("search and extraction prompts contain bounded repair data only", () => {
  const search = buildSearchPrompt(input);
  assertStringIncludes(search, '"year": "2018"');
  assert(!search.includes("customer"));
  const extraction = buildExtractionPrompt(input, "answer", [{
    id: "E1",
    text: "90916-A2027",
    sourceTitle: "Toyota Parts",
    sourceUrl: "https://secret.example/not-forwarded",
  }]);
  assertStringIncludes(extraction, '"evidence"');
  assert(!extraction.includes("https://secret.example"));
});

Deno.test("buildEvidenceBlocks maps supported text to grounded HTTPS chunks", () => {
  assertEquals(buildEvidenceBlocks(metadata), [
    {
      id: "E1",
      text: "2.5L OEM belt 90916-A2027",
      sourceTitle: "Toyota Parts",
      sourceUrl: "https://parts.example/oem",
    },
    {
      id: "E2",
      text: "2.5L aftermarket Gates K060615",
      sourceTitle: "Gates Catalog",
      sourceUrl: "https://parts.example/gates",
    },
  ]);
  assertEquals(buildEvidenceBlocks(undefined), []);
});

Deno.test("normalizePartResearch requires cited evidence containing the part number", () => {
  const evidence = buildEvidenceBlocks(metadata);
  const result = normalizePartResearch(
    input,
    {
      services: [{
        itemId: "belt",
        engineVariants: [{
          engineVariant: "2.5L I4",
          candidates: [
            {
              partType: "oem",
              brand: "Toyota",
              partNumber: "90916-A2027",
              fitmentNote: "2.5L catalog fitment",
            },
            {
              partType: "aftermarket",
              brand: "Invented",
              partNumber: "NO-SUPPORT",
              fitmentNote: "Not in evidence",
            },
            {
              partType: "aftermarket",
              brand: "Gates",
              partNumber: "K060615",
              fitmentNote: "2.5L catalog fitment",
            },
          ],
        }],
      }],
    },
    evidence,
    "2026-07-13T00:00:00.000Z",
  );

  assertEquals(
    result.referencesByItemId.belt.map((reference) => reference.partNumber),
    ["90916-A2027", "K060615"],
  );
});

Deno.test("normalizePartResearch de-duplicates and caps repeated engine blocks at three", () => {
  const evidence = Array.from({ length: 4 }, (_, index) => ({
    id: `E${index + 1}`,
    text: `Supported BELT-${index + 1}`,
    sourceTitle: "Catalog",
    sourceUrl: `https://parts.example/${index + 1}`,
  }));
  const candidate = (index: number) => ({
    partType: "aftermarket" as const,
    brand: "Gates",
    partNumber: `BELT-${index}`,
    fitmentNote: "Supported fitment",
  });
  const result = normalizePartResearch(
    input,
    {
      services: [{
        itemId: "belt",
        engineVariants: [
          { engineVariant: "2.5L I4", candidates: [candidate(1), candidate(1)] },
          { engineVariant: "2.5L I4", candidates: [candidate(2), candidate(3), candidate(4)] },
        ],
      }],
    },
    evidence,
    "2026-07-13T00:00:00.000Z",
  );

  assertEquals(
    result.referencesByItemId.belt.map((reference) => reference.partNumber),
    ["BELT-1", "BELT-2", "BELT-3"],
  );
});

Deno.test("normalizePartResearch rejects marketplace-only evidence", () => {
  const result = normalizePartResearch(input, {
    services: [{
      itemId: "belt",
      engineVariants: [{
        engineVariant: "2.5L I4",
        candidates: [{
          partType: "aftermarket",
          brand: "Unknown",
          partNumber: "BELT-ONLY",
          fitmentNote: "Marketplace claim",
        }],
      }],
    }],
  }, [{
    id: "E1",
    text: "BELT-ONLY",
    sourceTitle: "ebay.com",
    sourceUrl: "https://ebay.com/example",
  }], "2026-07-13T00:00:00.000Z");

  assertEquals(result.referencesByItemId, {});
});

Deno.test("researchPartNumbers skips extraction without grounding evidence", async () => {
  let extracted = false;
  const result = await researchPartNumbers(input, {
    search: () => Promise.resolve({ answer: "unsourced", groundingMetadata: null }),
    extract: () => {
      extracted = true;
      throw new Error("should not run");
    },
  });
  assertEquals(extracted, false);
  assertEquals(result.referencesByItemId, {});
  assertEquals(result.evidenceCount, 0);
});

Deno.test("researchPartNumbers runs both passes and combines usage", async () => {
  const result = await researchPartNumbers(input, {
    now: () => new Date("2026-07-13T01:02:03.000Z"),
    search: (_input, prompt) => {
      assertStringIncludes(prompt, "Serpentine Belt Replacement");
      return Promise.resolve({
        answer: "2.5L OEM belt 90916-A2027",
        groundingMetadata: metadata,
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
        model: "search-model",
      });
    },
    extract: (_input, prompt) => {
      assertStringIncludes(prompt, "E1");
      return Promise.resolve({
        output: {
          services: [{
            itemId: "belt",
            engineVariants: [{
              engineVariant: "2.5L I4",
              candidates: [{
                partType: "oem",
                brand: "Toyota",
                partNumber: "90916-A2027",
                fitmentNote: "2.5L catalog fitment",
              }],
            }],
          }],
        },
        usage: { inputTokens: 50, outputTokens: 75, totalTokens: 125 },
        model: "extract-model",
      });
    },
  });

  assertEquals(result.referencesByItemId.belt[0].searchedAt, "2026-07-13T01:02:03.000Z");
  assertEquals(result.totalUsage, { inputTokens: 150, outputTokens: 275, totalTokens: 425 });
  assertEquals(result.sourceCount, 2);
});
