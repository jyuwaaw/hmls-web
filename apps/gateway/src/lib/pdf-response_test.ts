import { assert, assertEquals } from "@std/assert";
import { EstimatePdf } from "@hmls/agent";
import { pdfResponse } from "./pdf-response.ts";

// Regression guard for the Deno Deploy PDF 500: the route handlers must hand
// back a fully buffered byte body (Uint8Array), not a raw @react-pdf Node
// `Readable`. A Node stream renders locally but errors mid-transmission on
// Deno Deploy, escaping Hono's onError as an opaque platform 500. This test
// locks in that `pdfResponse` produces a readable, valid PDF with the right
// headers. (The Deploy-specific stream failure cannot be reproduced under
// local `deno test` — local node-compat accepts the Node stream — so this
// verifies the contract, not the runtime divergence.)
Deno.test("pdfResponse returns a buffered, valid PDF with correct headers", async () => {
  const res = await pdfResponse(
    EstimatePdf({
      estimate: {
        id: 468,
        items: [
          { name: "Synthetic Oil Change", description: "", price: 12000 },
          { name: "Diagnostic Fee", description: "", price: 8000 },
          { name: "Hazmat Disposal", description: "", price: 950 },
        ],
        subtotal: 22950,
        priceRangeLow: 20655,
        priceRangeHigh: 25245,
        notes: null,
        expiresAt: new Date("2026-07-01"),
        createdAt: new Date("2024-05-01"),
      },
      customer: {
        name: "Angie",
        phone: null,
        email: null,
        address: "17662 Armstrong Ave, Irvine",
        vehicleInfo: { year: "2023", make: "Toyota", model: "Sienna" },
      },
    }),
    "HMLS-Estimate-468.pdf",
  );

  assertEquals(res.headers.get("Content-Type"), "application/pdf");
  assertEquals(
    res.headers.get("Content-Disposition"),
    'inline; filename="HMLS-Estimate-468.pdf"',
  );

  const bytes = new Uint8Array(await res.arrayBuffer());
  assert(bytes.length > 0, "PDF body should not be empty");
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "body should be a PDF");
});
