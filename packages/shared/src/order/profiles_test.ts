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
  "confirm_tentative_booking",
  "confirm_booking",
  "reject_booking",
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

Deno.test("every OrderStatus has a profile", () => {
  for (const status of Object.keys(TRANSITIONS) as OrderStatus[]) {
    assert(STATUS_PROFILES[status], `missing profile for ${status}`);
    assertEquals(STATUS_PROFILES[status].status, status);
  }
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

Deno.test("cancelled has no actions", () => {
  assertEquals(STATUS_PROFILES.cancelled.actions.length, 0);
  // completed intentionally allows mark_paid (non-transition action).
});
