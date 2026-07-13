# Tech Prep Reference Part Numbers — Implementation Plan

**Goal:** Persist the exact recommended part returned by the existing RockAuto lookup and display it in the internal Tech prep card.

**Architecture:** Extend the lookup result with a structured `recommendedPart`, pass that reference through the existing `create_order` service input, save it on the JSON-backed order item, and render a conditional de-duplicated subsection. OEM numbers remain optional and are never inferred.

**Tech stack:** Deno + TypeScript + Zod for agent tools, shared TypeScript order schema, Next.js/React for the admin UI, Deno and Bun tests.

**Design:** `docs/superpowers/specs/2026-07-12-tech-prep-reference-part-numbers-design.md` (`7b4d945`).

## Constraints

- No SQL migration or new environment variable.
- No live catalog request from the admin page.
- No extra model call and no guessed OEM number.
- Missing references remain non-blocking and invisible.
- Customer-facing surfaces must not render reference data.

## Task 1: Make the selected lookup option explicit

**Files:**

- Modify `apps/agent/src/common/tools/parts-lookup.ts`.
- Create `apps/agent/src/common/tools/parts-lookup_test.ts`.

**Steps:**

- Export a pure result formatter for unit coverage.
- Select one concrete option using the existing tier and median rules.
- Derive `recommendedPrice` from that option and return it as `recommendedPart` with part name, brand, part number, and source.
- Test Premium, Daily Driver, Economy, and fallback selection.

## Task 2: Persist validated references on order items

**Files:**

- Modify `packages/shared/src/db/schema.ts`.
- Modify `apps/agent/src/hmls/skills/estimate/types.ts`.
- Modify `apps/agent/src/common/tools/order.ts`.
- Create `apps/agent/src/common/tools/order-part-references_test.ts`.
- Modify `apps/agent/src/hmls/system-prompt.ts`.
- Modify `apps/agent/src/hmls/staff-system-prompt.ts`.

**Steps:**

- Add the shared optional `PartReference` and `OrderItem.referenceParts` JSON shape.
- Add the matching optional service input and Zod schema.
- Normalize whitespace, reject empty required values, and de-duplicate references before item construction.
- Copy references onto the service's labor order item without changing pricing.
- Instruct customer and staff agents to pass the lookup's exact `recommendedPart` through the existing create-order call.
- Unit-test validation, OEM preservation, and de-duplication.

## Task 3: Render the Tech prep subsection

**Files:**

- Modify `apps/hmls-web/components/order/TechPrepCard.tsx`.
- Create `apps/hmls-web/components/order/TechPrepCard.test.ts`.

**Steps:**

- Extract a pure collector that tolerates absent/malformed legacy values and de-duplicates references.
- Render **Reference part numbers** only when saved references exist.
- Show service/part name, brand, aftermarket number, and an explicitly labeled optional OEM number.
- Update the internal footer with VIN/engine/fitment verification guidance.
- Test absent, aftermarket-only, OEM, malformed, and duplicate inputs.

## Task 4: Verify and run locally

- Format changed Deno and web files.
- Run focused tests, agent check, web test/typecheck/lint/build, and repository diff checks.
- Use the existing Infisical configuration to start the required local services without printing secrets.
- Open the local admin order UI and verify wide and narrow layouts. If no safe local record contains reference data, use a local-only fixture or document the data limitation rather than mutating production data.
