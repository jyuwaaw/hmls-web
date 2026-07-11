import { assertEquals } from "@std/assert";
import {
  CUSTOMER_VISIBLE_EVENT_TYPES,
  filterCustomerVisibleEvents,
  INTERNAL_ORDER_FIELDS,
  toCustomerOrder,
} from "@hmls/shared/db/schema";
import { portal } from "./portal.ts";

// The 401 path short-circuits before any DB call runs — no env vars needed.

Deno.test("portal: rejects missing Authorization header", async () => {
  const res = await portal.request("/me/orders/1", { method: "GET" });
  assertEquals(res.status, 401);
});

// ---------------------------------------------------------------------------
// Customer-visible event projection (used by GET /me/orders/:id). Pure —
// exercises the shared allowlist + strip logic the route delegates to.
// ---------------------------------------------------------------------------

function event(eventType: string, extra: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    orderId: 1,
    eventType,
    fromStatus: null as string | null,
    toStatus: null as string | null,
    actor: "admin:alice@shop.com",
    metadata: {} as Record<string, unknown>,
    createdAt: new Date(),
    ...extra,
  };
}

Deno.test("portal events: internal types are excluded (allowlist)", () => {
  const events = [
    event("note_added", { metadata: { note: "internal staff note" } }),
    event("customer_contacted", { metadata: { method: "call", note: "voicemail" } }),
    event("contact_edited"),
  ];
  assertEquals(filterCustomerVisibleEvents(events), []);
});

Deno.test("portal events: status_change is included, metadata + actor stripped", () => {
  const events = [
    event("status_change", {
      fromStatus: "estimated",
      toStatus: "approved",
      metadata: {
        authorization: {
          channel: "call",
          note: "spoke with owner",
          revisionNumber: 2,
          subtotalCents: 12300,
        },
      },
    }),
  ];
  const visible = filterCustomerVisibleEvents(events);
  assertEquals(visible.length, 1);
  assertEquals(visible[0].eventType, "status_change");
  assertEquals(visible[0].toStatus, "approved");
  assertEquals("metadata" in visible[0], false, "evidence metadata must not leak");
  assertEquals("actor" in visible[0], false, "staff identity must not leak");
});

Deno.test("portal events: unknown future event types are private by default", () => {
  const events = [event("some_future_internal_event")];
  assertEquals(filterCustomerVisibleEvents(events), []);
});

Deno.test("portal events: allowlist covers exactly the customer-relevant types", () => {
  assertEquals(
    [...CUSTOMER_VISIBLE_EVENT_TYPES].sort(),
    [
      "items_edited",
      "payment_recorded",
      "provider_assigned",
      "schedule_attached",
      "status_change",
    ],
  );
});

// ---------------------------------------------------------------------------
// Customer-facing order projection (used by every portal order read). The row
// must never carry internal staff columns.
// ---------------------------------------------------------------------------

Deno.test("toCustomerOrder: strips adminNotes and fixoPredictionId", () => {
  const raw = {
    id: 7,
    status: "approved",
    subtotalCents: 12300,
    adminNotes: "⚠ geocode failed — verify before dispatch",
    fixoPredictionId: "pred_abc123",
    contactName: "Jane",
  };
  const safe = toCustomerOrder(raw);
  assertEquals("adminNotes" in safe, false, "internal staff notes must not leak");
  assertEquals("fixoPredictionId" in safe, false, "internal brain id must not leak");
  assertEquals(safe.id, 7, "customer-safe fields are preserved");
  assertEquals(safe.subtotalCents, 12300);
  assertEquals(safe.contactName, "Jane");
});

Deno.test("toCustomerOrder: INTERNAL_ORDER_FIELDS is the stripped set", () => {
  assertEquals([...INTERNAL_ORDER_FIELDS].sort(), ["adminNotes", "fixoPredictionId"]);
});
