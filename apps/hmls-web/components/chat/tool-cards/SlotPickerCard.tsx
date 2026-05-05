"use client";

import { useMemo, useState } from "react";

export interface SlotPickerOutput {
  slots: Array<{
    providerId: number;
    providerName: string;
    isPreferred: boolean;
    availableTimes: string[];
  }>;
  serviceDurationMinutes: number;
  dateRange: { start: string; end: string };
  message: string;
}

type TimeBucket = "Morning" | "Afternoon" | "Evening";

function bucketFor(time: string): TimeBucket {
  const hour = new Date(time).getHours();
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatTimeLabel(time: string): string {
  return new Date(time).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatPickedSlotMessage(time: string): string {
  const timeLabel = formatTimeLabel(time);
  const dateLabel = new Date(time).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return `I'd like the ${timeLabel} slot on ${dateLabel}.`;
}

/** Date + time picker rendered inline for the `get_availability` tool result.
 *
 * `isAnswered` follows the AskUserQuestion pattern: once the user picks a slot
 * and the next user message lands, the picker disables itself. */
export function SlotPickerCard({
  output,
  isAnswered,
  onSelect,
}: {
  output: SlotPickerOutput;
  isAnswered: boolean;
  onSelect: (message: string) => void;
}) {
  const { dates, timesByDate } = useMemo(() => {
    const timesByDate = new Map<string, Set<string>>();
    for (const provider of output.slots) {
      for (const time of provider.availableTimes) {
        const dateKey = time.split("T")[0];
        let timeSet = timesByDate.get(dateKey);
        if (!timeSet) {
          timeSet = new Set();
          timesByDate.set(dateKey, timeSet);
        }
        timeSet.add(time);
      }
    }
    const dates = Array.from(timesByDate.keys()).sort();
    return { dates, timesByDate };
  }, [output.slots]);

  const [selectedDate, setSelectedDate] = useState<string>(dates[0] ?? "");
  const [selectedTime, setSelectedTime] = useState<string>("");

  if (output.slots.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        {output.message}
      </div>
    );
  }

  const timeSet = selectedDate
    ? (timesByDate.get(selectedDate) ?? new Set<string>())
    : new Set<string>();
  const times = Array.from(timeSet).sort();

  const handleConfirm = () => {
    if (!selectedTime) return;
    onSelect(formatPickedSlotMessage(selectedTime));
  };

  const canConfirm = Boolean(selectedDate && selectedTime) && !isAnswered;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <label
          htmlFor="slot-date"
          className="block text-xs font-medium text-muted-foreground mb-1"
        >
          Date
        </label>
        <select
          id="slot-date"
          value={selectedDate}
          onChange={(e) => {
            setSelectedDate(e.target.value);
            setSelectedTime("");
          }}
          disabled={isAnswered}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        >
          {dates.map((d) => (
            <option key={d} value={d}>
              {formatDateLabel(d)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="slot-time"
          className="block text-xs font-medium text-muted-foreground mb-1"
        >
          Time
        </label>
        <select
          id="slot-time"
          value={selectedTime}
          onChange={(e) => setSelectedTime(e.target.value)}
          disabled={isAnswered || times.length === 0}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        >
          <option value="" disabled>
            Select a time
          </option>
          {(["Morning", "Afternoon", "Evening"] as TimeBucket[]).map(
            (bucket) => {
              const inBucket = times.filter((t) => bucketFor(t) === bucket);
              if (inBucket.length === 0) return null;
              return (
                <optgroup key={bucket} label={bucket}>
                  {inBucket.map((t) => (
                    <option key={t} value={t}>
                      {formatTimeLabel(t)}
                    </option>
                  ))}
                </optgroup>
              );
            },
          )}
        </select>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Our team will assign a mechanic and confirm your appointment shortly.
      </p>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={!canConfirm}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary"
      >
        {isAnswered ? "Pending confirmation" : "Book Appointment"}
      </button>
    </div>
  );
}
