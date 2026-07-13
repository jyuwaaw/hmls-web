# Tech Prep Reference Part Numbers Design

## Summary

Persist the exact part reference selected by the existing RockAuto pricing lookup and show it in a new **Reference part numbers** subsection of the internal Tech prep card on the admin order page.

The feature reuses the existing parts lookup and order `items` JSON data. It does not perform a lookup when the order page renders, does not add a model call, and does not require a database migration or a new secret. The existing model turn will pass a small structured reference through `create_order`, adding only negligible tool-call tokens.

## Goals

- Show the shop which aftermarket part number supported the saved estimate.
- Preserve the selected reference at order-creation or revision time so historical orders do not change when catalog results change.
- Keep the information internal to the admin Tech prep surface.
- Display an OEM part number only when the lookup source explicitly provides a trustworthy cross-reference.
- Keep order creation best-effort: a missing or failed parts lookup must not block an order.

## Non-goals

- Building or licensing an OEM parts catalog.
- Guessing an OEM part number from an aftermarket number or free-form description.
- Re-querying RockAuto from the order detail page.
- Backfilling reference numbers onto existing orders.
- Showing internal reference numbers in customer-facing estimates or portal pages.

## Current Behavior

`lookup_parts_price` queries RockAuto and returns priced aftermarket options containing `brand`, `partNumber`, and `price`. It separately calculates a `recommendedPrice`, but it does not identify the exact option that supplied that price.

The agent passes only `partsCost` into `create_order`. The pricing flow stores a combined service line in the order's JSON `items` array and discards the selected brand and part number. `TechPrepCard` renders vehicle-independent repair enrichment attached to labor items, but it has no saved catalog reference to display.

## Proposed Data Model

Add a reusable internal reference shape:

```ts
interface PartReference {
  partName: string;
  brand: string;
  partNumber: string;
  source: "rockauto";
  oemPartNumber?: string;
}
```

Add `referenceParts?: PartReference[]` to `OrderItem`. Although the initial flow normally saves one recommended reference per service, an array avoids a later schema break for services that require several separately looked-up parts.

Order items are already stored as JSON, so this is an additive type/schema change with no SQL migration. Existing rows remain valid because the field is optional.

## Lookup and Persistence Flow

1. `lookup_parts_price` keeps the existing tier preference: Premium, then Daily Driver/Standard, then Economy.
2. It chooses the same median option currently used to derive `recommendedPrice` and exposes that full option as `recommendedPart`.
3. `recommendedPrice` is derived directly from `recommendedPart.price`, ensuring the price and reference cannot point to different options.
4. The agent passes the structured recommended reference with the matching service in the existing `create_order` call.
5. The order pricing mapper copies valid references onto the corresponding labor `OrderItem` without changing pricing calculations.
6. When an order is revised through `create_order`, references are regenerated from that revision's service inputs together with the rest of the items.

The new fields do not trigger another model or catalog call. They add only a small amount of structured data to the tool result and existing create-order arguments.

## OEM Handling

RockAuto's current parsed result reliably supplies an aftermarket manufacturer part number, not a guaranteed OEM cross-reference. The feature therefore treats `oemPartNumber` as optional.

The implementation may populate it only when the catalog response exposes a separately identifiable OEM number using an explicit, testable field or label. It must not extract an OEM number from ambiguous prose, infer one from the aftermarket number, or call an additional AI model. If no trustworthy OEM value is available, the field is omitted and the UI shows only the aftermarket reference.

## User Interface

`TechPrepCard` gains a **Reference part numbers** subsection after the per-job prep details and before the existing internal-use footnote.

Each saved reference displays:

- The related service or part name.
- The aftermarket brand and part number as the primary reference.
- `OEM <number>` as a secondary labeled value only when present.

The subsection renders only when at least one order item contains a valid saved reference. The card's existing behavior remains unchanged for older orders. Reference numbers are plain text for easy copying; they are not purchase links and are clearly prep references rather than guaranteed fitment.

The existing footer will be updated to communicate that catalog references must be verified for VIN, engine, and fitment before purchase.

## Validation and Error Handling

- Empty brands or part numbers are not persisted.
- An unavailable or failed parts lookup leaves `referenceParts` absent and does not block pricing or order creation.
- Malformed legacy JSON is handled through the same defensive optional rendering used by the existing Tech prep data.
- Duplicate references within one service are de-duplicated by normalized source, brand, and part number before display.
- Customer-facing order and estimate components do not render `referenceParts`.

## Testing

- Unit-test lookup formatting to prove `recommendedPrice` and `recommendedPart` come from the same selected option across Premium, Daily Driver, Economy, and fallback cases.
- Unit-test order item construction to prove valid references persist and empty references are omitted.
- Add component coverage for a Tech prep card with aftermarket-only, aftermarket-plus-OEM, multiple, duplicate, and absent references where the current test setup supports React rendering.
- Run agent tests/checks and web tests, typecheck, lint, and production build.
- Start the required local services with Infisical-provided configuration, open an admin order in the local app, and visually verify desktop and narrow layouts.

## Local Deployment

The implementation will use the repository's existing local commands. Infisical is needed only to supply the application's existing database/auth/agent configuration; this feature introduces no new environment variable.

If the current Infisical setup is available to this shell, no input is required from the user. If access is unavailable, request only the appropriate Infisical login/session or the project-specific command/profile needed to inject the already-configured secrets. Secrets must not be printed or copied into committed files.

## Acceptance Criteria

- A newly priced order persists the exact recommended aftermarket brand and part number used by the lookup.
- The admin Tech prep card displays saved references in a clearly labeled subsection.
- A verified OEM cross-reference is labeled and displayed when available; otherwise no OEM value is shown.
- Older orders and lookup failures continue to render and create successfully.
- No reference data appears on customer-facing surfaces.
- No extra model call, SQL migration, or new secret is required.
- Automated checks pass and the feature is verified on the locally running application.
