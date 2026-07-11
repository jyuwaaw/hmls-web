import { describe, expect, it } from "bun:test";
import type { OrderEvent } from "@hmls/shared/db/types";
import { eventDescription } from "./ActivityTimeline";

function event(overrides: Partial<OrderEvent>): OrderEvent {
  return {
    id: "e1",
    orderId: 1,
    eventType: "note_added",
    fromStatus: null,
    toStatus: null,
    actor: "admin:test",
    metadata: {},
    createdAt: "2026-07-09T00:00:00Z",
    ...overrides,
  } as OrderEvent;
}

describe("eventDescription — customer_contacted", () => {
  it("maps each method to its verb", () => {
    expect(
      eventDescription(
        event({
          eventType: "customer_contacted",
          metadata: { method: "text" },
        }),
      ),
    ).toBe("Texted customer");
    expect(
      eventDescription(
        event({
          eventType: "customer_contacted",
          metadata: { method: "call" },
        }),
      ),
    ).toBe("Called customer");
    expect(
      eventDescription(
        event({
          eventType: "customer_contacted",
          metadata: { method: "email" },
        }),
      ),
    ).toBe("Emailed customer");
  });

  it("appends the note when present", () => {
    expect(
      eventDescription(
        event({
          eventType: "customer_contacted",
          metadata: { method: "call", note: "left voicemail" },
        }),
      ),
    ).toBe("Called customer — left voicemail");
  });

  it("falls back to neutral Contacted when method is missing or unknown", () => {
    expect(
      eventDescription(
        event({ eventType: "customer_contacted", metadata: {} }),
      ),
    ).toBe("Contacted customer");
    expect(
      eventDescription(
        event({ eventType: "customer_contacted", metadata: { method: "fax" } }),
      ),
    ).toBe("Contacted customer");
  });

  it("tolerates null metadata", () => {
    expect(
      eventDescription(
        event({
          eventType: "customer_contacted",
          metadata: null as unknown as OrderEvent["metadata"],
        }),
      ),
    ).toBe("Contacted customer");
  });
});

describe("eventDescription — status_change history rendering", () => {
  it("renders canonical statuses with their display labels", () => {
    expect(
      eventDescription(
        event({
          eventType: "status_change",
          fromStatus: "draft",
          toStatus: "estimated",
        }),
      ),
    ).toBe("Status changed from Draft → Estimated");
  });

  it("renders retired legacy statuses with their historical labels (history is immutable)", () => {
    expect(
      eventDescription(
        event({
          eventType: "status_change",
          fromStatus: "approved",
          toStatus: "scheduled",
        }),
      ),
    ).toBe("Status changed from Approved → Scheduled");
    expect(
      eventDescription(
        event({
          eventType: "status_change",
          fromStatus: "declined",
          toStatus: "revised",
        }),
      ),
    ).toBe("Status changed from Declined → Revised");
  });

  it("falls back to the raw label for unknown statuses instead of crashing", () => {
    expect(
      eventDescription(
        event({
          eventType: "status_change",
          fromStatus: "mystery",
          toStatus: "draft",
        }),
      ),
    ).toBe("Status changed from mystery → Draft");
  });
});

describe("eventDescription — existing branches (regression pins)", () => {
  it("note_added shows the note", () => {
    expect(
      eventDescription(
        event({ eventType: "note_added", metadata: { note: "called shop" } }),
      ),
    ).toBe("Note: called shop");
  });

  it("unknown types humanize underscores", () => {
    expect(
      eventDescription(
        event({ eventType: "schedule_attached" as OrderEvent["eventType"] }),
      ),
    ).toBe("schedule attached");
  });
});
