---
title: Browser-local grounded part-number lookup
date: 2026-07-12
status: approved
supersedes: 2026-07-12-tech-prep-online-part-lookup-design.md persistence and lookup-runtime sections
---

# Browser-local grounded part-number lookup

## Problem

The first implementation combined Gemini Google Search with AI SDK structured output. Live tests
proved that the model generated candidate data but did not invoke Google Search in that mode:
`sourceCount` was zero for every tested order. The safety normalizer therefore rejected every
candidate and the endpoint correctly wrote nothing. A plain-text Gemini call using the same Google
Search tool returned grounded engine variants, part numbers, and source links for a 2018 Toyota
Camry serpentine-belt lookup.

The replacement must use that working grounded-text behavior while keeping search results entirely
out of the HMLS database. Results should survive a page refresh in the browser that performed the
lookup.

## User experience

The internal Tech prep card keeps its **Look up part numbers** button. A successful lookup displays
compact cards grouped first by service and then by detected engine variant. Each group contains up
to three references. Every reference shows:

- brand and part number;
- OEM or aftermarket status when known;
- a short fitment note; and
- a clickable source label that opens the grounded HTTPS link.

After a successful lookup, the button becomes **Refresh part numbers**. Refresh replaces the prior
browser-local result only after a new lookup succeeds. A page refresh restores the saved cards from
the same browser. Results are not shared with another browser, device, or employee and disappear if
the browser's site data is cleared.

Existing RockAuto references already attached to an order may continue to display. The new Gemini
lookup never adds to or changes an order's `items` JSON.

## Stateless API boundary

The browser calls a stateless admin endpoint with a bounded payload containing only:

- vehicle year, make, and model; and
- eligible Tech prep service IDs and names.

The payload contains no customer name, contact data, address, VIN, notes, price, or order ID. The
endpoint is protected by the existing admin authentication middleware. Its handler does not import
the HMLS database client and does not select, insert, or update any application table. Normal page
loading remains responsible for obtaining the order shown in the browser.

Request validation limits field lengths and service count. A short in-process cooldown prevents
accidental repeated model calls. The endpoint returns browser-display records, not database
`PartReference` values.

## Grounded two-pass research

### Pass 1: Google-grounded answer

Call Gemini with `generateText`, `google.tools.googleSearch({})`, and no structured-output mode. The
prompt asks for all applicable engine variants and up to three well-supported OEM or reputable
aftermarket part numbers per variant.

Capture the answer text, URL sources, usage, and Google grounding metadata. Convert
`groundingSupports` and their referenced `groundingChunks` into numbered evidence blocks. Each block
includes the supported text segment and only the HTTPS source URLs attached to that segment. Google
grounding redirect URLs are acceptable; they open the supporting catalog or product page.

If Gemini returns no usable evidence blocks, the lookup returns `no_results` and performs no second
call.

### Pass 2: bounded extraction

Call a lightweight Gemini model without search tools and use strict structured output. Its input is
limited to the vehicle/services, first-pass answer, and numbered evidence blocks. It extracts:

- service ID;
- engine variant;
- brand;
- part number;
- OEM or aftermarket type;
- short fitment note; and
- no source URL or database field.

The deterministic normalizer accepts a candidate only when:

1. its service ID came from the request;
2. its part number appears literally in a grounded evidence block;
3. that evidence block contains a non-marketplace HTTPS source; and
4. it is not a duplicate or beyond the three-per-engine cap.

The server finds the evidence block by normalized part-number matching instead of trusting the
extractor to choose a citation. The displayed link and title come from that accepted evidence block,
never from an extractor-created URL. This prevents the second call from inventing or misbinding a
source.

## Browser-local persistence

The Tech prep component stores successful online results in `localStorage` under a versioned key
scoped to the order and shop. The stored envelope contains:

- schema version;
- a deterministic vehicle/service fingerprint;
- save timestamp; and
- normalized display records.

On mount, the component parses the envelope defensively. It ignores malformed data, unsupported
versions, unsafe URLs, and records whose fingerprint no longer matches the current vehicle and
eligible services. This prevents references for an old vehicle or changed repair scope from being
shown on the same order.

If `localStorage` is unavailable, a successful result remains visible for the current component
session but is not persisted. No failure clears the last valid cached result.

## Errors and observability

- No grounding evidence: return `no_results`; show “No sourced matches found.”
- Extraction or provider failure: return a non-2xx error; retain the last successful browser result.
- Partial evidence: return and display only accepted candidates.
- Malformed browser cache: ignore it without breaking the Tech prep card.
- Log model, duration, source/evidence/reference counts, and token usage. Do not log prompts,
  customer information, full model answers, or source URLs.

The UI continues to warn staff to verify fitment by VIN and engine before purchasing.

## Token use

The first live Camry grounded-text diagnostic used 866 tokens. The complete evidence-rich two-pass
lookup used 2,568 tokens, so the expected range is approximately 1,800–3,000 tokens per button
click. Loading or refreshing a page consumes no model tokens because it reads browser-local data.

## Testing and acceptance

Automated tests cover:

- grounding-support to evidence-block conversion;
- rejection of candidates without non-marketplace HTTPS evidence or a literal part-number match in
  supported text;
- de-duplication and the three-per-engine cap;
- stateless endpoint authentication and request validation;
- proof that the lookup route has no HMLS database dependency;
- localStorage keying, fingerprint invalidation, malformed-cache handling, and safe URL parsing; and
- grouped OEM/aftermarket display with source links.

Local acceptance uses the existing 2018 Toyota Camry serpentine-belt order. The button must return
both applicable engine variants when grounded evidence supports them, render linked part-number
cards, retain them after a page refresh in the same browser, and leave the order database unchanged.

## Out of scope

- Sharing results across browsers, users, or devices.
- Writing Gemini results into `orders.items` or any other table.
- VIN-specific fitment guarantees or automatic purchasing.
- A new database table, migration, background job, or scheduled refresh.
