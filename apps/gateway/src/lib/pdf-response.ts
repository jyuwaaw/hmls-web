import { renderToBuffer } from "@react-pdf/renderer";

/**
 * Render a `@react-pdf/renderer` document to a complete byte buffer and return
 * it as an inline PDF HTTP response.
 *
 * We buffer instead of streaming on purpose. `renderToStream` returns a
 * Node.js `Readable` (a pdfkit `PDFDocument`). Local `deno run` adapts that
 * into a web `Response` body via node-compat, but Deno Deploy's production
 * runtime does not — the body errors mid-transmission, escapes Hono's
 * `onError` (the Response has already been returned), and surfaces as an
 * opaque platform 500 ("Sorry, there was an issue loading this page").
 *
 * `renderToBuffer` returns a `Uint8Array` (Buffer), which is a standard web
 * body type and streams correctly everywhere. It also moves the whole render
 * inside the awaited handler, so a render failure is now a catchable,
 * loggable error instead of a silent stream break.
 */
export async function pdfResponse(
  document: Parameters<typeof renderToBuffer>[0],
  filename: string,
): Promise<Response> {
  const buffer = await renderToBuffer(document);
  // `renderToBuffer` returns a Node `Buffer`, which Deno's type checker does
  // not accept as `BodyInit`. Copy into a plain `Uint8Array` — a standard web
  // body type — to keep both the types and the Deno Deploy runtime happy.
  // The copy is deliberate: it snapshots the bytes off any pooled Node buffer
  // (no aliasing surprises) and these documents are small (single-digit KB), so
  // the extra allocation is negligible — do not "optimize" this into a zero-copy
  // view over `buffer.buffer`.
  // Strip CR/LF/quotes from the filename so it can't break or inject the
  // header. Current callers pass int/UUID-derived names, but this is the shared
  // PDF entry point — keep it safe by construction for future callers.
  const safeName = filename.replace(/[\r\n"]/g, "");
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}"`,
    },
  });
}
