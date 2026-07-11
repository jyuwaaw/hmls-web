import { describe, expect, test } from "bun:test";
import {
  canonicalStatus,
  historicalStatusLabel,
  isBookedOrder,
  isTentativeBooking,
  orderSubBadge,
  statusDisplay,
} from "./status-display";

describe("canonicalStatus", () => {
  test("passes canonical statuses through", () => {
    expect(canonicalStatus("draft")).toBe("draft");
    expect(canonicalStatus("in_progress")).toBe("in_progress");
  });

  test("maps window-period legacy labels", () => {
    expect(canonicalStatus("scheduled")).toBe("approved");
    expect(canonicalStatus("revised")).toBe("draft");
  });

  test("returns null (not a throw) for unknown values", () => {
    expect(canonicalStatus("mystery")).toBeNull();
    expect(canonicalStatus("")).toBeNull();
  });
});

describe("statusDisplay", () => {
  test("legacy physical rows render as their canonical status", () => {
    expect(statusDisplay("scheduled").label).toBe("Approved");
    expect(statusDisplay("revised").label).toBe("Draft");
    expect(statusDisplay("revised", "portal").label).toBe("Preparing");
  });

  test("unknown statuses fall back to the raw label", () => {
    expect(statusDisplay("mystery").label).toBe("mystery");
  });

  test("scheduledBooking surfaces an approved booking as Scheduled", () => {
    expect(
      statusDisplay("approved", "portal", { scheduledBooking: true }).label,
    ).toBe("Scheduled");
    // Flag is ignored off the approved status.
    expect(
      statusDisplay("estimated", "portal", { scheduledBooking: true }).label,
    ).toBe("Estimate Ready");
  });

  test("tentativeBooking still wins for drafts (incl. legacy revised rows)", () => {
    expect(
      statusDisplay("revised", "portal", { tentativeBooking: true }).label,
    ).toBe("Pending Confirmation");
  });
});

describe("historicalStatusLabel", () => {
  test("keeps historical wording for retired statuses", () => {
    expect(historicalStatusLabel("scheduled")).toBe("Scheduled");
    expect(historicalStatusLabel("revised")).toBe("Revised");
    expect(historicalStatusLabel("revised", "portal")).toBe("Updated Estimate");
  });

  test("uses display labels for canonical statuses and raw for unknowns", () => {
    expect(historicalStatusLabel("in_progress")).toBe("In Progress");
    expect(historicalStatusLabel("completed", "portal")).toBe("Complete");
    expect(historicalStatusLabel("mystery")).toBe("mystery");
  });
});

describe("orderSubBadge — draft dual semantics", () => {
  test("fresh AI draft (never sent) → Pending review", () => {
    expect(
      orderSubBadge({
        status: "draft",
        revisionNumber: 1,
        statusHistory: [{ status: "draft" }],
      })?.label,
    ).toBe("Pending review");
  });

  test("revisionNumber alone never marks a draft as revising", () => {
    // revisionNumber is an optimistic-concurrency counter — pure-draft edits
    // bump it. Only the send history (statusHistory contains 'estimated')
    // makes a draft a revision.
    expect(
      orderSubBadge({
        status: "draft",
        revisionNumber: 3,
        statusHistory: [{ status: "draft" }],
      })?.label,
    ).toBe("Pending review");
  });

  test("pulled-back draft (sent before) → Revising · rev N", () => {
    expect(
      orderSubBadge({
        status: "draft",
        revisionNumber: 2,
        statusHistory: [
          { status: "draft" },
          { status: "estimated" },
          { status: "draft" },
        ],
      })?.label,
    ).toBe("Revising · rev 2");
  });

  test("legacy physical 'revised' rows get the revising badge too", () => {
    expect(
      orderSubBadge({
        status: "revised",
        revisionNumber: 4,
        statusHistory: [{ status: "estimated" }, { status: "revised" }],
      })?.label,
    ).toBe("Revising · rev 4");
  });
});

describe("orderSubBadge — approved schedule derivation", () => {
  test("slot + mechanic complete → Scheduled", () => {
    expect(
      orderSubBadge({
        status: "approved",
        scheduledAt: "2026-07-11T10:00:00Z",
        providerId: 7,
      })?.label,
    ).toBe("Scheduled");
  });

  test("missing slot or mechanic → Pending schedule", () => {
    expect(
      orderSubBadge({ status: "approved", scheduledAt: null, providerId: 7 })
        ?.label,
    ).toBe("Pending schedule");
    expect(
      orderSubBadge({
        status: "approved",
        scheduledAt: "2026-07-11T10:00:00Z",
        providerId: null,
      })?.label,
    ).toBe("Pending schedule");
  });

  test("other statuses have no sub-badge", () => {
    expect(orderSubBadge({ status: "estimated" })).toBeNull();
    expect(orderSubBadge({ status: "completed" })).toBeNull();
    expect(orderSubBadge({ status: "mystery" })).toBeNull();
  });
});

describe("booking predicates", () => {
  test("isBookedOrder requires approved + slot + mechanic", () => {
    expect(
      isBookedOrder({
        status: "approved",
        scheduledAt: "2026-07-11T10:00:00Z",
        providerId: 7,
      }),
    ).toBe(true);
    // Legacy physical 'scheduled' rows canonicalize to approved.
    expect(
      isBookedOrder({
        status: "scheduled",
        scheduledAt: "2026-07-11T10:00:00Z",
        providerId: 7,
      }),
    ).toBe(true);
    expect(
      isBookedOrder({ status: "approved", scheduledAt: null, providerId: 7 }),
    ).toBe(false);
    expect(
      isBookedOrder({
        status: "in_progress",
        scheduledAt: "2026-07-11T10:00:00Z",
        providerId: 7,
      }),
    ).toBe(false);
  });

  test("isTentativeBooking covers legacy revised rows with a slot", () => {
    expect(
      isTentativeBooking({
        status: "draft",
        scheduledAt: "2026-07-11T10:00:00Z",
      }),
    ).toBe(true);
    expect(
      isTentativeBooking({
        status: "revised",
        scheduledAt: "2026-07-11T10:00:00Z",
      }),
    ).toBe(true);
    expect(isTentativeBooking({ status: "draft", scheduledAt: null })).toBe(
      false,
    );
  });
});
