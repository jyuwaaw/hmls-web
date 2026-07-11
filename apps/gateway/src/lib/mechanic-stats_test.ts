import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  availableMinutesForWeek,
  bookedMinutesForWeek,
  computeUtilization,
  endOfWeek,
  isOnJobNow,
  startOfWeek,
} from "./mechanic-stats.ts";

// Helper: freeze "now" to a known Monday 10:00 UTC.
const NOW = new Date("2026-04-20T10:00:00.000Z"); // Monday

Deno.test("startOfWeek returns Monday 00:00 UTC for a mid-week date", () => {
  const wed = new Date("2026-04-22T15:30:00.000Z");
  const start = startOfWeek(wed);
  assertEquals(start.toISOString(), "2026-04-20T00:00:00.000Z");
});

Deno.test("endOfWeek returns next Monday 00:00 UTC (exclusive)", () => {
  const end = endOfWeek(NOW);
  assertEquals(end.toISOString(), "2026-04-27T00:00:00.000Z");
});

Deno.test("availableMinutesForWeek sums weekly hours across 7 days", () => {
  // 9am-5pm Mon-Fri = 5 days * 8h = 40h = 2400 min
  const weekly = [
    { dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00" },
    { dayOfWeek: 2, startTime: "09:00:00", endTime: "17:00:00" },
    { dayOfWeek: 3, startTime: "09:00:00", endTime: "17:00:00" },
    { dayOfWeek: 4, startTime: "09:00:00", endTime: "17:00:00" },
    { dayOfWeek: 5, startTime: "09:00:00", endTime: "17:00:00" },
  ];
  const mins = availableMinutesForWeek(weekly, [], NOW);
  assertEquals(mins, 2400);
});

Deno.test("availableMinutesForWeek subtracts full-day unavailable overrides", () => {
  const weekly = [
    { dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00" }, // 480
    { dayOfWeek: 2, startTime: "09:00:00", endTime: "17:00:00" }, // 480
  ];
  // Tuesday this week is 2026-04-21. Mark it unavailable.
  const overrides = [
    {
      overrideDate: "2026-04-21",
      isAvailable: false,
      startTime: null,
      endTime: null,
    },
  ];
  const mins = availableMinutesForWeek(weekly, overrides, NOW);
  assertEquals(mins, 480);
});

Deno.test("availableMinutesForWeek adds extra-hours overrides on non-working days", () => {
  const weekly: { dayOfWeek: number; startTime: string; endTime: string }[] = [];
  // Saturday 2026-04-25 extra shift 10:00-14:00 = 240 min
  const overrides = [
    {
      overrideDate: "2026-04-25",
      isAvailable: true,
      startTime: "10:00:00",
      endTime: "14:00:00",
    },
  ];
  const mins = availableMinutesForWeek(weekly, overrides, NOW);
  assertEquals(mins, 240);
});

Deno.test("availableMinutesForWeek stacks extra-hours overrides on top of weekly hours", () => {
  // Monday weekly 09:00-17:00 (480). Extra-hours override 17:00-19:00 (+120).
  // Result must be 600 — earlier bug replaced the weekly slot with the override.
  const weekly = [
    { dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00" },
  ];
  const overrides = [
    {
      overrideDate: "2026-04-20", // Monday this week
      isAvailable: true,
      startTime: "17:00:00",
      endTime: "19:00:00",
    },
  ];
  assertEquals(availableMinutesForWeek(weekly, overrides, NOW), 600);
});

Deno.test("bookedMinutesForWeek sums durations of bookings in the week", () => {
  const bookings = [
    // Booked = approved + slot (7-state machine).
    {
      scheduledAt: new Date("2026-04-21T14:00:00.000Z"),
      durationMinutes: 60,
      status: "approved",
    },
    {
      scheduledAt: new Date("2026-04-22T09:00:00.000Z"),
      durationMinutes: 45,
      status: "in_progress",
    },
    {
      scheduledAt: new Date("2026-04-23T10:00:00.000Z"),
      durationMinutes: 90,
      status: "completed",
    },
    // Legacy pre-remap label — still counts during the deploy→remap window.
    {
      scheduledAt: new Date("2026-04-24T10:00:00.000Z"),
      durationMinutes: 30,
      status: "scheduled",
    },
    // Next week — excluded
    {
      scheduledAt: new Date("2026-04-28T10:00:00.000Z"),
      durationMinutes: 60,
      status: "approved",
    },
    // Declined — excluded
    {
      scheduledAt: new Date("2026-04-22T10:00:00.000Z"),
      durationMinutes: 60,
      status: "declined",
    },
  ];
  assertEquals(bookedMinutesForWeek(bookings, NOW), 225);
});

Deno.test("computeUtilization returns null when available is 0", () => {
  assertEquals(computeUtilization(0, 100), null);
});

Deno.test("computeUtilization rounds to integer percent", () => {
  assertAlmostEquals(computeUtilization(480, 120)!, 25, 0.01);
});

Deno.test("isOnJobNow returns true when current time is inside an in_progress booking", () => {
  const bookings = [
    {
      scheduledAt: new Date("2026-04-20T09:30:00.000Z"),
      durationMinutes: 60,
      status: "in_progress",
    },
  ];
  assertEquals(isOnJobNow(bookings, NOW), true);
});

Deno.test("isOnJobNow ignores a booked (not-yet-started) job even if its window covers now", () => {
  const bookings = [
    {
      scheduledAt: new Date("2026-04-20T09:30:00.000Z"),
      durationMinutes: 60,
      status: "approved",
    },
  ];
  assertEquals(isOnJobNow(bookings, NOW), false);
});

Deno.test("isOnJobNow returns false when no booking covers now", () => {
  const bookings = [
    {
      scheduledAt: new Date("2026-04-20T12:00:00.000Z"),
      durationMinutes: 60,
      status: "in_progress",
    },
  ];
  assertEquals(isOnJobNow(bookings, NOW), false);
});
