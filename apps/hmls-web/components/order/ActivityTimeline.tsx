"use client";

import type { ContactMethod } from "@hmls/shared/api/contracts/orders";
import type { OrderEvent } from "@hmls/shared/db/types";
import {
  ClipboardEdit,
  MessageSquare,
  PhoneCall,
  Tag,
  User,
} from "lucide-react";
import { historicalStatusLabel } from "@/lib/status-display";

/** Past-tense verb per contact method — shared by the timeline description and
 * the Log-contact buttons so the button label always matches the event it logs. */
export const CONTACT_VERB: Record<ContactMethod, string> = {
  text: "Texted",
  call: "Called",
  email: "Emailed",
};

function isContactMethod(v: unknown): v is ContactMethod {
  return v === "text" || v === "call" || v === "email";
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function eventDescription(event: OrderEvent): string {
  switch (event.eventType) {
    case "status_change":
      if (event.fromStatus && event.toStatus) {
        // History is immutable — pre-collapse events keep their historical
        // labels (Scheduled/Revised) instead of being canonicalized away.
        const fromLabel = historicalStatusLabel(event.fromStatus);
        const toLabel = historicalStatusLabel(event.toStatus);
        return `Status changed from ${fromLabel} → ${toLabel}`;
      }
      return "Status changed";
    case "items_edited":
      return "Line items updated";
    case "contact_edited":
      return "Contact info updated";
    case "note_added": {
      const note = (event.metadata as { note?: string })?.note;
      return note ? `Note: ${note}` : "Note added";
    }
    case "customer_contacted": {
      const { method, note } = (event.metadata ?? {}) as {
        method?: string;
        note?: string;
      };
      // Unknown/missing method → neutral "Contacted", never a wrong verb.
      const verb = isContactMethod(method) ? CONTACT_VERB[method] : "Contacted";
      return note ? `${verb} customer — ${note}` : `${verb} customer`;
    }
    default:
      return event.eventType.replace(/_/g, " ");
  }
}

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType === "status_change") {
    return (
      <div className="w-6 h-6 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
        <Tag className="w-3 h-3 text-emerald-500" />
      </div>
    );
  }
  if (eventType === "items_edited") {
    return (
      <div className="w-6 h-6 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0">
        <ClipboardEdit className="w-3 h-3 text-blue-400" />
      </div>
    );
  }
  if (eventType === "contact_edited") {
    return (
      <div className="w-6 h-6 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
        <User className="w-3 h-3 text-purple-400" />
      </div>
    );
  }
  if (eventType === "note_added") {
    return (
      <div className="w-6 h-6 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center shrink-0">
        <MessageSquare className="w-3 h-3 text-yellow-400" />
      </div>
    );
  }
  if (eventType === "customer_contacted") {
    return (
      <div className="w-6 h-6 rounded-full bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
        <PhoneCall className="w-3 h-3 text-sky-400" />
      </div>
    );
  }
  return (
    <div className="w-6 h-6 rounded-full bg-muted border border-border flex items-center justify-center shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
    </div>
  );
}

export function ActivityTimeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">
        No activity recorded yet.
      </p>
    );
  }
  return (
    <div className="space-y-0">
      {events.map((event, idx) => (
        <div key={event.id} className="flex gap-3">
          {/* Timeline line + icon */}
          <div className="flex flex-col items-center">
            <EventIcon eventType={event.eventType} />
            {idx < events.length - 1 && (
              <div className="w-px flex-1 bg-border mt-1 mb-1" />
            )}
          </div>
          {/* Content */}
          <div className="pb-3 min-w-0 flex-1">
            <p className="text-xs text-foreground leading-snug">
              {eventDescription(event)}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">
                {event.actor}
              </span>
              <span className="text-[10px] text-muted-foreground">·</span>
              <span className="text-[10px] text-muted-foreground">
                {event.createdAt ? relativeTime(event.createdAt) : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
