import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildEvidenceBlocks,
  buildExtractionPrompt,
  buildFallbackRetailerEntries,
  buildSearchQuery,
  normalizePartResearch,
  type PartResearchInput,
  researchPartNumbers,
  retailerFromUrl,
  runTavilySearch,
} from "./part-number-research.ts";

const input: PartResearchInput = {
  vehicle: { year: "2018", make: "Toyota", model: "Camry" },
  services: [{ itemId: "belt", name: "Serpentine Belt Replacement" }],
  postalCode: "95113",
};

const searchResponse = {
  results: [
    {
      title: "Toyota Parts",
      url: "https://parts.example/oem",
      content: "2.5L OEM belt 90916-A2027",
      raw_content: null,
      score: 0.92,
    },
    {
      title: "Unsafe",
      url: "http://unsafe.example/belt",
      content: "unsafe BELT-HTTP",
      raw_content: null,
      score: 0.99,
    },
    {
      title: "Low score",
      url: "https://parts.example/low",
      content: "unsupported BELT-LOW",
      raw_content: null,
      score: 0.49,
    },
    {
      title: "Gates Catalog",
      url: "https://parts.example/gates",
      content: "2.5L aftermarket Gates K060615",
      raw_content: null,
      score: 0.81,
    },
  ],
  usage: { credits: 1 },
};

Deno.test("search and extraction prompts contain bounded repair data only", () => {
  const search = buildSearchQuery({
    ...input,
    services: [...input.services, { itemId: "brakes", name: "Front Brake Pads" }],
  });
  assertStringIncludes(search, "2018 Toyota Camry");
  assertStringIncludes(search, "[belt] Serpentine Belt Replacement");
  assertStringIncludes(search, "[brakes] Front Brake Pads");
  assertStringIncludes(search, "AutoZone");
  assertStringIncludes(search, "ZIP 95113");
  assert(!search.includes("customer"));
  const extraction = buildExtractionPrompt(input, [{
    id: "E1",
    text: "90916-A2027",
    sourceTitle: "Toyota Parts",
    sourceUrl: "https://secret.example/not-forwarded",
  }]);
  assertStringIncludes(extraction, '"evidence"');
  assert(!extraction.includes("https://secret.example"));
});

Deno.test("buildEvidenceBlocks maps relevant Tavily results to bounded HTTPS evidence", () => {
  assertEquals(buildEvidenceBlocks(searchResponse), [
    {
      id: "E1",
      text: "Toyota Parts\n2.5L OEM belt 90916-A2027",
      sourceTitle: "Toyota Parts",
      sourceUrl: "https://parts.example/oem",
      score: 0.92,
    },
    {
      id: "E2",
      text: "Gates Catalog\n2.5L aftermarket Gates K060615",
      sourceTitle: "Gates Catalog",
      sourceUrl: "https://parts.example/gates",
      score: 0.81,
    },
  ]);
  assertEquals(buildEvidenceBlocks(undefined), []);

  const bounded = buildEvidenceBlocks({
    results: [{
      title: "Long catalog",
      url: "https://parts.example/long",
      content: "BELT-LONG",
      raw_content: "x".repeat(10_000),
      score: 0.9,
    }],
  });
  assertEquals(bounded[0].text.length, 2_500);
});

Deno.test("normalizePartResearch requires cited evidence containing the part number", () => {
  const evidence = buildEvidenceBlocks(searchResponse);
  const result = normalizePartResearch(
    input,
    {
      services: [{
        itemId: "belt",
        engineVariants: [{
          engineVariant: "2.5L I4",
          retailerOffers: [],
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
          {
            engineVariant: "2.5L I4",
            candidates: [candidate(1), candidate(1)],
            retailerOffers: [],
          },
          {
            engineVariant: "2.5L I4",
            candidates: [candidate(2), candidate(3), candidate(4)],
            retailerOffers: [],
          },
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
        retailerOffers: [],
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

Deno.test("retailer domains reject lookalikes and fallback links stay allowlisted", () => {
  assertEquals(retailerFromUrl("https://www.autozone.com/p/belt"), "autozone");
  assertEquals(retailerFromUrl("https://shop.oreillyauto.com/p/belt"), "oreilly");
  assertEquals(retailerFromUrl("https://autozone.com.evil.example/p/belt"), null);
  const fallbacks = buildFallbackRetailerEntries(input).belt;
  assertEquals(fallbacks.length, 5);
  assertEquals(fallbacks.map((entry) => entry.retailer), [
    "autozone",
    "oreilly",
    "napa",
    "walmart",
    "amazon",
  ]);
  assert(
    fallbacks.every((entry) => entry.kind === "search" && entry.sourceUrl.startsWith("https://")),
  );
});

Deno.test("normalizePartResearch grounds prices, filters Amazon ratings, and ranks local first", () => {
  const evidence = buildEvidenceBlocks({
    results: [
      {
        title: "Toyota Parts",
        url: "https://parts.example/oem",
        content: "2018 Toyota Camry 2.5L belt 90916-A2027",
        raw_content: null,
        score: 0.95,
      },
      {
        title: "AutoZone Gates Belt",
        url: "https://www.autozone.com/belts/gates-k060615",
        content: "Gates K060615 fits 2018 Toyota Camry. Price $24.99",
        raw_content: null,
        score: 0.9,
      },
      {
        title: "Amazon Belt",
        url: "https://www.amazon.com/example/dp/AMZ615",
        content: "AMZ615 fits 2018 Toyota Camry. $19.99. 4.4 out of 5 stars",
        raw_content: null,
        score: 0.88,
      },
      {
        title: "Amazon Low Rated Belt",
        url: "https://www.amazon.com/example/dp/LOW615",
        content: "LOW615 fits 2018 Toyota Camry. $9.99. 3.9 out of 5 stars",
        raw_content: null,
        score: 0.87,
      },
    ],
  });
  const result = normalizePartResearch(
    input,
    {
      services: [{
        itemId: "belt",
        engineVariants: [{
          engineVariant: "2.5L I4",
          candidates: [{
            partType: "oem",
            brand: "Toyota",
            partNumber: "90916-A2027",
            fitmentNote: "2018 Camry 2.5L",
          }],
          retailerOffers: [
            {
              productTitle: "Gates Serpentine Belt",
              brand: "Gates",
              partNumber: "K060615",
              fitmentNote: "2018 Camry fitment",
              priceCents: 2499,
              rating: null,
            },
            {
              productTitle: "Amazon Serpentine Belt",
              brand: "Generic",
              partNumber: "AMZ615",
              fitmentNote: "2018 Camry fitment",
              priceCents: 1999,
              rating: 4.4,
            },
            {
              productTitle: "Low Rated Belt",
              brand: "Generic",
              partNumber: "LOW615",
              fitmentNote: "2018 Camry fitment",
              priceCents: 999,
              rating: 3.9,
            },
          ],
        }],
      }],
    },
    evidence,
    "2026-07-13T00:00:00.000Z",
  );

  const entries = result.retailerEntriesByItemId.belt;
  assertEquals(entries.length, 5);
  assertEquals(entries[0].kind, "offer");
  assertEquals(entries[0].retailer, "autozone");
  assertEquals(entries[0].kind === "offer" ? entries[0].priceCents : null, 2499);
  assertEquals(entries[1].kind, "offer");
  assertEquals(entries[1].retailer, "amazon");
  assertEquals(entries.filter((entry) => entry.kind === "offer").length, 2);
});

Deno.test("buildEvidenceBlocks enforces the total evidence budget", () => {
  const evidence = buildEvidenceBlocks({
    results: Array.from({ length: 20 }, (_, index) => ({
      title: `Catalog ${index}`,
      url: `https://parts${index}.example/belt`,
      content: `BELT-${index}`,
      raw_content: "x".repeat(5_000),
      score: 0.99 - index / 100,
    })),
  });
  assert(evidence.reduce((sum, block) => sum + block.text.length, 0) <= 40_000);
});

Deno.test("researchPartNumbers skips extraction and returns retailer fallbacks without evidence", async () => {
  let extracted = false;
  const result = await researchPartNumbers(input, {
    search: () =>
      Promise.resolve({
        response: { results: [] },
        provider: "tavily",
        usage: { credits: 1 },
      }),
    extract: () => {
      extracted = true;
      throw new Error("should not run");
    },
  });
  assertEquals(extracted, false);
  assertEquals(result.referencesByItemId, {});
  assertEquals(result.retailerEntriesByItemId.belt.length, 5);
  assert(result.retailerEntriesByItemId.belt.every((entry) => entry.kind === "search"));
  assertEquals(result.evidenceCount, 0);
});

Deno.test("researchPartNumbers runs both passes and combines usage", async () => {
  let searchCalls = 0;
  const result = await researchPartNumbers(input, {
    now: () => new Date("2026-07-13T01:02:03.000Z"),
    search: (_input, query) => {
      searchCalls += 1;
      assertStringIncludes(query, "Serpentine Belt Replacement");
      return Promise.resolve({
        response: searchResponse,
        usage: { credits: 1 },
        provider: "tavily",
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
              retailerOffers: [],
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

  assertEquals(searchCalls, 1);
  assertEquals(result.referencesByItemId.belt[0].searchedAt, "2026-07-13T01:02:03.000Z");
  assertEquals(result.searchUsage, { credits: 1 });
  assertEquals(result.totalUsage, { inputTokens: 50, outputTokens: 75, totalTokens: 125 });
  assertEquals(result.searchProvider, "tavily");
  assertEquals(result.sourceCount, 2);
});

Deno.test("runTavilySearch sends one bounded Basic Search request", async () => {
  let calls = 0;
  const result = await runTavilySearch(input, buildSearchQuery(input), {
    apiKey: "test-key",
    timeoutMs: 100,
    fetcher: (_url, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("authorization"), "Bearer test-key");
      assert(init?.signal instanceof AbortSignal);
      const body = JSON.parse(String(init?.body));
      assertEquals(body.search_depth, "basic");
      assertEquals(body.max_results, 20);
      assertEquals(body.include_answer, false);
      assertEquals(body.include_raw_content, "text");
      assertEquals(body.include_usage, true);
      return Promise.resolve(Response.json(searchResponse));
    },
  });

  assertEquals(calls, 1);
  assertEquals(result.provider, "tavily");
  assertEquals(result.usage, { credits: 1 });
});

Deno.test("runTavilySearch sanitizes provider and timeout failures", async () => {
  for (
    const [status, message] of [
      [401, "Part-number search is not configured correctly"],
      [429, "Part-number search quota or rate limit was reached"],
      [503, "Part-number search provider is temporarily unavailable"],
    ] as const
  ) {
    await runTavilySearch(input, "query", {
      apiKey: "test-key",
      fetcher: () => Promise.resolve(new Response("secret body", { status })),
    }).then(
      () => {
        throw new Error("expected failure");
      },
      (error) => assertEquals(error.message, message),
    );
  }

  await runTavilySearch(input, "query", {
    apiKey: "test-key",
    fetcher: () => Promise.reject(new DOMException("private", "AbortError")),
  }).then(
    () => {
      throw new Error("expected timeout");
    },
    (error) => assertEquals(error.message, "Part-number search timed out"),
  );

  await runTavilySearch(input, "query", {
    apiKey: "test-key",
    fetcher: () => Promise.resolve(Response.json({ results: "not-an-array" })),
  }).then(
    () => {
      throw new Error("expected invalid response");
    },
    (error) =>
      assertEquals(error.message, "Part-number search provider returned an invalid response"),
  );
});

Deno.test("part-number research has no Google provider dependency", async () => {
  const source = await Deno.readTextFile(
    new URL("./part-number-research.ts", import.meta.url),
  );
  assert(!source.includes("GOOGLE_API_KEY"));
  assert(!source.includes("@ai-sdk/google"));
  assert(!source.includes("createGoogleGenerativeAI"));
});
