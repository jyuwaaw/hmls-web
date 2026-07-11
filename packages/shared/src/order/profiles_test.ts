import { assert, assertEquals } from "@std/assert";
import type { OrderStatus } from "./status.ts";
import { TRANSITIONS } from "./status.ts";
import type { ActionId, EditableSection } from "./profiles.ts";
import { STATUS_PROFILES } from "./profiles.ts";

const VALID_ACTION_IDS = new Set<ActionId>([
  "send_to_customer",
  "approve_estimate",
  "decline_estimate",
  "revise_estimate",
  "approve_walk_in",
  "reassign_mechanic",
  "reschedule",
  "set_time",
  "start_job",
  "complete_job",
  "cancel_order",
  "mark_paid",
]);

const VALID_SECTIONS = new Set<EditableSection>([
  "items",
  "customer",
  "schedule",
  "notes",
  "diagnosis",
]);

Deno.test("every OrderStatus has a profile (7 states, no scheduled/revised)", () => {
  const statuses = Object.keys(TRANSITIONS) as OrderStatus[];
  assertEquals(statuses.length, 7);
  for (const status of statuses) {
    assert(STATUS_PROFILES[status], `missing profile for ${status}`);
    assertEquals(STATUS_PROFILES[status].status, status);
  }
  // No orphan profiles for retired states.
  assertEquals(Object.keys(STATUS_PROFILES).length, 7);
});

Deno.test("profile.actions reference valid ActionIds", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    for (const id of profile.actions) {
      assert(VALID_ACTION_IDS.has(id), `${status}.actions has invalid ${id}`);
    }
  }
});

Deno.test("profile.primary, when set, must be in profile.actions", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    if (profile.primary == null) continue;
    assert(
      profile.actions.includes(profile.primary),
      `${status}.primary=${profile.primary} not in actions`,
    );
  }
});

Deno.test("profile.editableSections reference valid sections", () => {
  for (const [status, profile] of Object.entries(STATUS_PROFILES)) {
    for (const s of profile.editableSections) {
      assert(VALID_SECTIONS.has(s), `${status}.editableSections has invalid ${s}`);
    }
  }
});

Deno.test("approved absorbs scheduling: schedule editable + start_job available", () => {
  const approved = STATUS_PROFILES.approved;
  assert(approved.editableSections.includes("schedule"), "approved must edit schedule");
  assert(approved.actions.includes("start_job"), "approved must offer start_job");
  assert(approved.actions.includes("set_time"), "approved must offer set_time");
  assert(!approved.actions.includes("approve_walk_in"), "walk-in shortcut is draft-only");
});

Deno.test("draft offers the walk-in shortcut and send", () => {
  const draft = STATUS_PROFILES.draft;
  assert(draft.actions.includes("approve_walk_in"));
  assert(draft.actions.includes("send_to_customer"));
  assertEquals(draft.primary, "send_to_customer");
});

Deno.test("declined can be revised (back to draft) or cancelled", () => {
  const declined = STATUS_PROFILES.declined;
  assert(declined.actions.includes("revise_estimate"));
  assert(declined.actions.includes("cancel_order"));
});

Deno.test("cancelled has no actions", () => {
  assertEquals(STATUS_PROFILES.cancelled.actions.length, 0);
  // completed intentionally allows mark_paid (non-transition action).
});
