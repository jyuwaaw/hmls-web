/**
 * Pure helpers for mechanic aggregate stats. No DB imports — callers pass in
 * already-fetched rows. Week is defined as Monday 00:00 UTC (inclusive) →
 * next Monday 00:00 UTC (exclusive). Times on provider_availability /
 * overrides are HH:MM[:SS] strings, interpreted as UTC-of-the-day here; this
 * matches how the mechanic self-service UI treats them today.
 */

export interface WeeklyRow {
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  startTime: string; // "HH:MM:SS" or "HH:MM"
  endTime: string;
}

export interface OverrideRow {
  overrideDate: string; // "YYYY-MM-DD"
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
}

export interface BookingRow {
  scheduledAt: Date;
  durationMinutes: number;
  status: string;
}

export function startOfWeek(d: Date): Date {
  // JS getUTCDay: 0=Sun..6=Sat. Convert to Monday-based offset.
  const dayOfWeek = d.getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7; // Mon -> 0, Sun -> 6
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return start;
}

export function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

export function availableMinutesForWeek(
  weekly: WeeklyRow[],
  overrides: OverrideRow[],
  now: Date,
): number {
  const start = startOfWeek(now);
  const end = endOfWeek(now);

  const weeklyByDow = new Map<number, WeeklyRow[]>();
  for (const row of weekly) {
    const list = weeklyByDow.get(row.dayOfWeek) ?? [];
    list.push(row);
    weeklyByDow.set(row.dayOfWeek, list);
  }

  const overridesByDate = new Map<string, OverrideRow>();
  for (const o of overrides) {
    overridesByDate.set(o.overrideDate, o);
  }

  let minutes = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    if (day >= end) break;

    const dow = day.getUTCDay();
    const dateKey = day.toISOString().slice(0, 10);
    const override = overridesByDate.get(dateKey);

    // Unavailable override (time off) cancels the day entirely.
    if (override && !override.isAvailable) continue;

    // Extra-hours override: add the override window on top of the weekly
    // schedule, not replace it. The UI surfaces overrides as "extra hours".
    if (override?.isAvailable && override.startTime && override.endTime) {
      minutes += timeToMinutes(override.endTime) -
        timeToMinutes(override.startTime);
    }

    for (const row of weeklyByDow.get(dow) ?? []) {
      minutes += timeToMinutes(row.endTime) - timeToMinutes(row.startTime);
    }
  }
  return minutes;
}

export function bookedMinutesForWeek(
  bookings: BookingRow[],
  now: Date,
): number {
  const start = startOfWeek(now);
  const end = endOfWeek(now);

  let minutes = 0;
  for (const b of bookings) {
    // order_status has no "confirmed" state — real booked/worked time is
    // scheduled (locked in), in_progress (underway), or completed (done).
    if (
      b.status !== "scheduled" &&
      b.status !== "in_progress" &&
      b.status !== "completed"
    ) {
      continue;
    }
    if (b.scheduledAt < start || b.scheduledAt >= end) continue;
    minutes += b.durationMinutes;
  }
  return minutes;
}

/** Returns integer percent utilization, or null when available == 0. */
export function computeUtilization(
  availableMinutes: number,
  bookedMinutes: number,
): number | null {
  if (availableMinutes <= 0) return null;
  return Math.round((bookedMinutes / availableMinutes) * 100);
}

export function isOnJobNow(bookings: BookingRow[], now: Date): boolean {
  for (const b of bookings) {
    // ponytail: "on a job right now" == in_progress only. A `scheduled` job
    // whose window includes `now` but that the mechanic hasn't started yet
    // is arguably also "on it", but conflating the two would make a
    // no-show/late-start look like active work — revisit if the UI needs
    // to distinguish "should be working" from "is working".
    if (b.status !== "in_progress") continue;
    const end = new Date(b.scheduledAt.getTime() + b.durationMinutes * 60_000);
    if (b.scheduledAt <= now && now < end) return true;
  }
  return false;
}
