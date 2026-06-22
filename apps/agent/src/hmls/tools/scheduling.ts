import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema, whereShop } from "../../db/client.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { ToolContext } from "../../common/convert-tools.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a date string + time string in a given IANA timezone to a UTC Date.
 *
 * For example toProviderTimestamp("2026-02-24", "08:00", "America/Los_Angeles")
 * returns the Date corresponding to 2026-02-24T08:00 Pacific (which is
 * 2026-02-24T16:00Z during standard time).
 */
function toProviderTimestamp(dateStr: string, timeStr: string, tz: string): Date {
  if (timeStr === "24:00" || timeStr === "24:00:00") {
    // "24:00" means midnight of the next day
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return toProviderTimestamp(d.toISOString().split("T")[0], "00:00", tz);
  }

  const [hours, minutes] = timeStr.split(":").map(Number);
  // Build a naive Date as if the wall-clock time were UTC
  const naive = new Date(
    `${dateStr}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`,
  );

  // Determine the UTC offset for the target timezone at that instant
  const utcStr = naive.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = naive.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();

  return new Date(naive.getTime() + diffMs);
}

/**
 * Subtract booked ranges from free ranges. All values are epoch-ms.
 */
function subtractRanges(
  freeRanges: Array<{ start: number; end: number }>,
  bookedRanges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  let result = [...freeRanges];
  for (const booked of bookedRanges) {
    const next: Array<{ start: number; end: number }> = [];
    for (const free of result) {
      if (booked.end <= free.start || booked.start >= free.end) {
        next.push(free); // no overlap
      } else {
        if (free.start < booked.start) next.push({ start: free.start, end: booked.start });
        if (free.end > booked.end) next.push({ start: booked.end, end: free.end });
      }
    }
    result = next;
  }
  return result;
}

/**
 * Turn a list of free ranges into discrete slot start times (ISO strings with
 * timezone offset) spaced at `slotIncrementMinutes` intervals, keeping only
 * those where `serviceDurationMinutes` fits entirely inside a free range.
 */
function discretizeSlots(
  freeRanges: Array<{ start: number; end: number }>,
  serviceDurationMinutes: number,
  slotIncrementMinutes: number,
  tz: string,
): string[] {
  // I6 - zero-increment guard
  if (slotIncrementMinutes <= 0) slotIncrementMinutes = 30;

  const durationMs = serviceDurationMinutes * 60_000;
  const incrementMs = slotIncrementMinutes * 60_000;
  const slots: string[] = [];

  for (const range of freeRanges) {
    // Snap the start up to the next increment boundary
    let cursor = Math.ceil(range.start / incrementMs) * incrementMs;
    while (cursor + durationMs <= range.end) {
      slots.push(formatWithOffset(new Date(cursor), tz));
      cursor += incrementMs;
    }
  }

  return slots;
}

/**
 * Format a Date as an ISO-8601 string with the timezone offset for the
 * given IANA zone (e.g. "2026-02-24T09:00:00-08:00").
 */
function formatWithOffset(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const datePart = `${parts.year}-${parts.month}-${parts.day}`;
  const timePart = `${parts.hour}:${parts.minute}:${parts.second}`;

  // Compute offset string
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  const offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const absMinutes = Math.abs(offsetMs / 60_000);
  const sign = offsetMs >= 0 ? "+" : "-";
  const oh = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const om = String(absMinutes % 60).padStart(2, "0");

  return `${datePart}T${timePart}${sign}${oh}:${om}`;
}

/**
 * Get the JS day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD string.
 */
function dayOfWeekForDate(dateStr: string): number {
  // Parse as UTC to avoid timezone shifts
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Generate an array of YYYY-MM-DD strings from start to end (inclusive).
 */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const last = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= last) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const getAvailabilityTool = {
  name: "get_availability",
  description: "Check available appointment time slots across active mechanics. " +
    "Returns slots grouped by provider, with any preferred mechanic listed first. " +
    "Use lookup_labor_time first to get the labor hours, then convert to minutes for durationMinutes.",
  schema: z.object({
    durationMinutes: z.number().describe(
      "Estimated service duration in minutes. Get labor hours from lookup_labor_time, then multiply by 60.",
    ),
    date: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z
      .string()
      .optional()
      .describe("End date in YYYY-MM-DD format (defaults to 7 days from date)"),
    preferredMechanicId: z
      .number()
      .optional()
      .describe("Provider ID to prioritize (from previous visits)"),
  }),
  execute: async (
    params: {
      durationMinutes: number;
      date: string;
      endDate?: string;
      preferredMechanicId?: number;
    },
    ctx: ToolContext | undefined,
  ) => {
    const serviceDurationMinutes = Math.max(30, Math.ceil(params.durationMinutes));
    const shopId = ctx?.shopId;

    // 1. Compute date range
    const startDate = params.date;
    const endDate = params.endDate ?? (() => {
      const d = new Date(startDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().split("T")[0];
    })();

    // 2. Find all active providers, scoped to this chat session's shop.
    const shopFilter = shopId ? whereShop(schema.providers.shopId, shopId) : undefined;
    const providers = await db
      .select({
        id: schema.providers.id,
        name: schema.providers.name,
        timezone: schema.providers.timezone,
      })
      .from(schema.providers)
      .where(and(eq(schema.providers.isActive, true), shopFilter));

    if (providers.length === 0) {
      return toolResult({
        slots: [],
        serviceDurationMinutes,
        dateRange: { start: startDate, end: endDate },
        message: "No active providers found for this service. Please call us at (949) 213-7073.",
      });
    }

    const providerIds = providers.map((p) => p.id);

    // 4a. Batch-fetch weekly availability for all providers
    const weeklyAvail = await db
      .select()
      .from(schema.providerAvailability)
      .where(inArray(schema.providerAvailability.providerId, providerIds));

    // Group by providerId -> dayOfWeek
    const weeklyByProvider = new Map<
      number,
      Map<number, { startTime: string; endTime: string }>
    >();
    for (const row of weeklyAvail) {
      if (!weeklyByProvider.has(row.providerId)) {
        weeklyByProvider.set(row.providerId, new Map());
      }
      weeklyByProvider.get(row.providerId)!.set(row.dayOfWeek, {
        startTime: row.startTime,
        endTime: row.endTime,
      });
    }

    // 4b. Batch-fetch schedule overrides in the date range (M8: use <=)
    const overrides = await db
      .select()
      .from(schema.providerScheduleOverrides)
      .where(
        and(
          inArray(schema.providerScheduleOverrides.providerId, providerIds),
          sql`${schema.providerScheduleOverrides.overrideDate} >= ${startDate}`,
          sql`${schema.providerScheduleOverrides.overrideDate} <= ${endDate}`,
        ),
      );

    // Group by providerId -> date
    const overridesByProvider = new Map<
      number,
      Map<string, typeof overrides[number]>
    >();
    for (const row of overrides) {
      if (!overridesByProvider.has(row.providerId)) {
        overridesByProvider.set(row.providerId, new Map());
      }
      overridesByProvider.get(row.providerId)!.set(row.overrideDate, row);
    }

    // 4c. Batch-fetch existing bookings (I3)
    // Build the outer range timestamps for the query
    const rangeStartTs = toProviderTimestamp(startDate, "00:00", "America/Los_Angeles");
    const rangeEndTs = toProviderTimestamp(endDate, "23:59", "America/Los_Angeles");
    // Add a day buffer to the end to catch bookings that span midnight
    rangeEndTs.setUTCDate(rangeEndTs.getUTCDate() + 1);

    const bookingsResult = await db.execute(
      sql`SELECT provider_id, lower(blocked_range) as range_start, upper(blocked_range) as range_end
          FROM orders
          WHERE provider_id = ANY(ARRAY[${
        sql.join(providerIds.map((id) => sql`${id}`), sql`, `)
      }]::int[])
          AND status NOT IN ('cancelled', 'completed', 'declined')
          AND blocked_range IS NOT NULL
          AND blocked_range && tstzrange(${rangeStartTs.toISOString()}::timestamptz, ${rangeEndTs.toISOString()}::timestamptz, '[)')
          ORDER BY provider_id`,
    );

    // Group blocked ranges by provider
    const bookingsByProvider = new Map<
      number,
      Array<{ start: number; end: number }>
    >();
    for (const row of bookingsResult) {
      const pid = row.provider_id as number;
      if (!bookingsByProvider.has(pid)) {
        bookingsByProvider.set(pid, []);
      }
      bookingsByProvider.get(pid)!.push({
        start: new Date(row.range_start as string).getTime(),
        end: new Date(row.range_end as string).getTime(),
      });
    }

    // 5. For each provider, compute available slots
    const dates = dateRange(startDate, endDate);
    const SLOT_INCREMENT = 60; // 1-hour snap points (less UI noise than 30-min)

    const providerSlots: Array<{
      providerId: number;
      providerName: string;
      isPreferred: boolean;
      availableTimes: string[];
    }> = [];

    for (const provider of providers) {
      const tz = provider.timezone;
      const weekly = weeklyByProvider.get(provider.id) ?? new Map();
      const provOverrides = overridesByProvider.get(provider.id) ?? new Map();
      const provBookings = bookingsByProvider.get(provider.id) ?? [];

      const allSlots: string[] = [];

      for (const dateStr of dates) {
        const dow = dayOfWeekForDate(dateStr);
        const override = provOverrides.get(dateStr);

        let dayStart: string | null = null;
        let dayEnd: string | null = null;

        if (override) {
          // Override takes precedence
          if (!override.isAvailable) continue; // day off
          dayStart = override.startTime ?? null;
          dayEnd = override.endTime ?? null;
        } else {
          const schedule = weekly.get(dow);
          if (!schedule) continue; // no schedule for this day
          dayStart = schedule.startTime;
          dayEnd = schedule.endTime;
        }

        if (!dayStart || !dayEnd) continue;

        // C2 - Build timezone-aware timestamps
        const workStart = toProviderTimestamp(dateStr, dayStart, tz);
        const workEnd = toProviderTimestamp(dateStr, dayEnd, tz);

        const freeRanges: Array<{ start: number; end: number }> = [
          { start: workStart.getTime(), end: workEnd.getTime() },
        ];

        // Subtract bookings' blocked_range
        const remaining = subtractRanges(freeRanges, provBookings);

        // C1 - Pass serviceDurationMinutes (NOT total blocked minutes)
        const daySlots = discretizeSlots(remaining, serviceDurationMinutes, SLOT_INCREMENT, tz);
        allSlots.push(...daySlots);
      }

      if (allSlots.length > 0) {
        providerSlots.push({
          providerId: provider.id,
          providerName: provider.name,
          isPreferred: provider.id === params.preferredMechanicId,
          availableTimes: allSlots,
        });
      }
    }

    // 6. Sort preferred mechanic first
    if (params.preferredMechanicId) {
      providerSlots.sort((a, b) => {
        if (a.isPreferred && !b.isPreferred) return -1;
        if (!a.isPreferred && b.isPreferred) return 1;
        return 0;
      });
    }

    const totalSlots = providerSlots.reduce((sum, p) => sum + p.availableTimes.length, 0);

    return toolResult({
      slots: providerSlots,
      serviceDurationMinutes,
      dateRange: { start: startDate, end: endDate },
      message: totalSlots > 0
        ? `Found ${totalSlots} available slot${
          totalSlots === 1 ? "" : "s"
        } across ${providerSlots.length} provider${providerSlots.length === 1 ? "" : "s"}.`
        : "No availability found. Please call us at (949) 213-7073.",
    });
  },
};

export const schedulingTools = [getAvailabilityTool];
