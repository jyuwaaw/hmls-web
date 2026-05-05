import type { StatusConfig } from "@/lib/status-display";

export function StatusBadge({
  status,
  config,
  entry,
}: {
  status?: string;
  config?: Record<string, StatusConfig>;
  /** Direct StatusConfig override. Use this when the badge needs to
   *  reflect a derived state (e.g. tentative booking) that isn't in the
   *  raw config map. Takes precedence over (status, config). */
  entry?: StatusConfig;
}) {
  const resolved = entry ??
    (status != null ? config?.[status] : undefined) ?? {
      label: status ?? "—",
      color: "bg-neutral-100 text-neutral-500",
    };
  return (
    <span
      className={`text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap ${resolved.color}`}
    >
      {resolved.label}
    </span>
  );
}
