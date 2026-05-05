"use client";

import { useState } from "react";
import useSWR from "swr";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";
import { ChatListItem } from "./ChatListItem";
import { VehicleGroupHeader } from "./VehicleGroupHeader";

interface SessionListItem {
  id: number;
  title: string | null;
  vehicleId: string | null;
  lastMessageAt: string;
  createdAt: string;
  archivedAt: string | null;
}

interface VehicleSummary {
  id: string;
  year: number | null;
  make: string;
  model: string;
  nickname?: string | null;
}

const fetcher = async ([url, token]: [string, string]) => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

export function ChatList() {
  const { session } = useAuth();
  const [showArchived, setShowArchived] = useState(false);

  const sessionsKey = session?.access_token
    ? [
        `${AGENT_URL}/sessions${showArchived ? "?include_archived=true" : ""}`,
        session.access_token,
      ]
    : null;

  const { data: sessionData, mutate } = useSWR<{
    sessions: SessionListItem[];
  }>(sessionsKey, fetcher, { revalidateOnFocus: false });

  const { data: vehicleData } = useSWR<{ vehicles: VehicleSummary[] }>(
    session?.access_token
      ? [`${AGENT_URL}/vehicles`, session.access_token]
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const sessions = sessionData?.sessions ?? [];
  const vehicles = vehicleData?.vehicles ?? [];

  const grouped = groupByVehicle(sessions, vehicles);

  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      {grouped.length === 0 && (
        <p className="px-2 py-3 text-[12px] text-muted-foreground">
          No chats yet.
        </p>
      )}
      {grouped.map((group) => (
        <VehicleGroupHeader key={group.key} label={group.label}>
          {group.sessions.map((s) => (
            <ChatListItem key={s.id} session={s} onMutate={mutate} />
          ))}
        </VehicleGroupHeader>
      ))}
      <label className="mt-2 flex cursor-pointer items-center gap-2 px-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived
      </label>
    </div>
  );
}

function groupByVehicle(
  sessions: SessionListItem[],
  vehicles: VehicleSummary[],
): { key: string; label: string; sessions: SessionListItem[] }[] {
  const map = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const key = s.vehicleId ?? "__unassigned__";
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }
  const entries = Array.from(map.entries()).map(([key, list]) => {
    if (key === "__unassigned__") {
      return { key, label: "Unassigned", sessions: list, latest: "" };
    }
    const v = vehicles.find((vv) => vv.id === key);
    const label = v
      ? [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"
      : "Unknown vehicle";
    return {
      key,
      label,
      sessions: list,
      latest: list[0]?.lastMessageAt ?? "",
    };
  });
  entries.sort((a, b) => {
    if (a.key === "__unassigned__") return 1;
    if (b.key === "__unassigned__") return -1;
    return b.latest.localeCompare(a.latest);
  });
  return entries.map(({ key, label, sessions }) => ({
    key,
    label,
    sessions,
  }));
}
