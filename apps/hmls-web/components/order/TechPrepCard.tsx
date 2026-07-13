"use client";

import type { OrderItem, PartReference } from "@hmls/shared/db/schema";
import type { Order } from "@hmls/shared/db/types";
import {
  AlertTriangle,
  ExternalLink,
  LoaderCircle,
  Search,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi } from "@/hooks/useApi";
import { adminPaths } from "@/lib/api-paths";
import {
  type OnlinePartReference,
  type OnlinePartReferencesByItemId,
  partReferenceCacheKey,
  partReferenceFingerprint,
  readPartReferenceCache,
  validateOnlinePartReferences,
  writePartReferenceCache,
} from "@/lib/part-reference-cache";
import { cn } from "@/lib/utils";

type TechPrep = NonNullable<OrderItem["techPrep"]>;
export type DisplayCatalogPartReference = PartReference & {
  serviceId: string;
  serviceName: string;
};

export type DisplayOnlinePartReference = OnlinePartReference & {
  serviceId: string;
  serviceName: string;
};

export type OnlineReferenceGroup = {
  serviceId: string;
  serviceName: string;
  engineVariant: string;
  references: DisplayOnlinePartReference[];
};

type PartLookupResponse = {
  referencesByItemId: unknown;
  lookup: {
    status: "found" | "no_results";
    referenceCount: number;
    emptyGroups: { itemId: string; engineVariant: string }[];
    sourceCount: number;
  };
};

const DIFFICULTY_LABEL = [
  "",
  "Routine",
  "Easy",
  "Moderate",
  "Hard",
  "Specialist",
];

/** Collect defensively from JSON-backed order items and de-dupe within a service. */
export function collectReferenceParts(
  items: readonly OrderItem[],
): DisplayCatalogPartReference[] {
  const collected: DisplayCatalogPartReference[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!Array.isArray(item.referenceParts)) continue;
    for (const raw of item.referenceParts) {
      if (!raw || typeof raw !== "object") continue;
      const partName =
        typeof raw.partName === "string" ? raw.partName.trim() : "";
      const brand = typeof raw.brand === "string" ? raw.brand.trim() : "";
      const partNumber =
        typeof raw.partNumber === "string" ? raw.partNumber.trim() : "";
      if (!partName || !brand || !partNumber || raw.source !== "rockauto")
        continue;

      const key = `${item.id}\u0000${brand.toLowerCase()}\u0000${partNumber.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const oemPartNumber =
        typeof raw.oemPartNumber === "string" ? raw.oemPartNumber.trim() : "";
      collected.push({
        serviceId: item.id,
        serviceName: item.name,
        partName,
        brand,
        partNumber,
        source: raw.source,
        ...(oemPartNumber ? { oemPartNumber } : {}),
      });
    }
  }

  return collected;
}

export function collectOnlineReferenceParts(
  items: readonly OrderItem[],
  referencesByItemId: OnlinePartReferencesByItemId,
): DisplayOnlinePartReference[] {
  const services = new Map(items.map((item) => [item.id, item.name]));
  const collected: DisplayOnlinePartReference[] = [];
  const seen = new Set<string>();
  for (const [serviceId, references] of Object.entries(referencesByItemId)) {
    const serviceName = services.get(serviceId);
    if (!serviceName) continue;
    for (const reference of references) {
      const key = `${serviceId}\u0000${reference.engineVariant.toLowerCase()}\u0000${reference.brand.toLowerCase()}\u0000${reference.partNumber.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...reference, serviceId, serviceName });
    }
  }
  return collected;
}

export function groupOnlineReferenceParts(
  references: readonly DisplayOnlinePartReference[],
): OnlineReferenceGroup[] {
  const groups = new Map<string, OnlineReferenceGroup>();
  for (const reference of references) {
    if (reference.source !== "google_search") continue;
    const engineVariant =
      reference.engineVariant?.trim() || "Engine not specified";
    const key = `${reference.serviceId}\u0000${engineVariant.toLowerCase()}`;
    const group = groups.get(key);
    if (group) {
      group.references.push(reference);
    } else {
      groups.set(key, {
        serviceId: reference.serviceId,
        serviceName: reference.serviceName,
        engineVariant,
        references: [reference],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Internal "Tech prep" panel for the shop's dispatcher / assigned mobile tech.
 * Surfaces the repair_jobs enrichment (tools, difficulty, HV-safety, notes)
 * and saved catalog references attached to each labor line at create_order
 * time. Renders nothing when neither kind of internal prep data is present.
 */
export function TechPrepCard({ order }: { order: Order }) {
  const api = useApi();
  const [lookingUp, setLookingUp] = useState(false);
  const [onlineReferencesByItemId, setOnlineReferencesByItemId] =
    useState<OnlinePartReferencesByItemId>({});
  const items = order.items ?? [];
  const jobs = items
    .map((it) =>
      it.techPrep ? { item: it, tp: it.techPrep as TechPrep } : null,
    )
    .filter((x): x is { item: OrderItem; tp: TechPrep } => x !== null);
  const catalogReferences = collectReferenceParts(items);
  const eligibleServices = jobs.map(({ item }) => ({
    itemId: item.id,
    name: item.name.trim(),
  }));
  const rawVehicle = order.vehicleInfo;
  const vehicle = {
    year: typeof rawVehicle?.year === "string" ? rawVehicle.year.trim() : "",
    make: typeof rawVehicle?.make === "string" ? rawVehicle.make.trim() : "",
    model: typeof rawVehicle?.model === "string" ? rawVehicle.model.trim() : "",
  };
  const canLookup = Boolean(
    vehicle.year &&
      vehicle.make &&
      vehicle.model &&
      eligibleServices.length > 0,
  );
  const fingerprint = partReferenceFingerprint(vehicle, eligibleServices);
  const cacheKey = partReferenceCacheKey(order.shopId, order.id);

  useEffect(() => {
    if (!canLookup) {
      setOnlineReferencesByItemId({});
      return;
    }
    setOnlineReferencesByItemId(
      readPartReferenceCache(window.localStorage, cacheKey, fingerprint) ?? {},
    );
  }, [cacheKey, canLookup, fingerprint]);

  const onlineReferences = collectOnlineReferenceParts(
    items,
    onlineReferencesByItemId,
  );
  const onlineGroups = groupOnlineReferenceParts(onlineReferences);

  if (jobs.length === 0 && catalogReferences.length === 0) return null;

  const maxDifficulty =
    jobs.length > 0 ? Math.max(...jobs.map((j) => j.tp.difficulty)) : null;
  const hvRequired = jobs.some((j) => j.tp.hvSafety);

  // Consolidated, de-duped tools to bring; specialty tools sort first + starred.
  const toolMap = new Map<string, boolean>();
  for (const j of jobs) {
    for (const t of j.tp.tools) {
      toolMap.set(t.name, (toolMap.get(t.name) ?? false) || !!t.specialty);
    }
  }
  const tools = [...toolMap.entries()].sort(
    (a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]),
  );

  async function lookupPartNumbers() {
    if (!canLookup) {
      toast.error("Vehicle year, make, and model are required for part lookup");
      return;
    }
    setLookingUp(true);
    try {
      const result = await api.post<PartLookupResponse>(
        adminPaths.partReferenceLookup(),
        { vehicle, services: eligibleServices },
      );
      if (result.lookup.status === "no_results") {
        toast.info("No sourced part-number matches were found");
        return;
      }
      const validated = validateOnlinePartReferences(result.referencesByItemId);
      if (!validated) throw new Error("Part lookup returned malformed results");
      setOnlineReferencesByItemId(validated);
      writePartReferenceCache(
        window.localStorage,
        cacheKey,
        fingerprint,
        validated,
      );
      const suffix =
        result.lookup.emptyGroups.length > 0
          ? " Some engine variants had no verified match."
          : "";
      toast.success(
        `Found ${result.lookup.referenceCount} reference part number${
          result.lookup.referenceCount === 1 ? "" : "s"
        }.${suffix}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Part-number lookup failed",
      );
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <Card className="gap-0 py-0 border-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" /> Tech prep
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {maxDifficulty !== null && (
            <Badge variant="secondary" className="text-[10px]">
              Difficulty {maxDifficulty}/5 · {DIFFICULTY_LABEL[maxDifficulty]}
            </Badge>
          )}
          {hvRequired && (
            <Badge
              variant="destructive"
              className="text-[10px] flex items-center gap-1"
            >
              <AlertTriangle className="w-3 h-3" /> HV-certified tech
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-3">
        {/* Tools to bring */}
        {jobs.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              Tools to bring
            </p>
            <div className="flex flex-wrap gap-1.5">
              {tools.map(([name, specialty]) => (
                <span
                  key={name}
                  className={cn(
                    "px-1.5 py-0.5 rounded border text-[11px]",
                    specialty
                      ? "border-foreground/40 text-foreground font-medium"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {specialty ? "★ " : ""}
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Per-job detail */}
        {jobs.length > 0 && (
          <div className="space-y-1.5">
            {jobs.map((j) => (
              <div key={j.item.id} className="border-t border-border pt-1.5">
                <div className="flex justify-between gap-2">
                  <span className="text-foreground">{j.item.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    Diff {j.tp.difficulty}/5
                  </span>
                </div>
                {j.tp.notes && (
                  <p className="text-muted-foreground mt-0.5">{j.tp.notes}</p>
                )}
                {j.tp.likelySizes && j.tp.likelySizes.length > 0 && (
                  <p className="text-muted-foreground mt-0.5">
                    Sizes: {j.tp.likelySizes.join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {(jobs.length > 0 || catalogReferences.length > 0) && (
          <div className="border-t border-border pt-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Reference part numbers
              </p>
              {jobs.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={lookingUp || !canLookup}
                  onClick={lookupPartNumbers}
                >
                  {lookingUp ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Search />
                  )}
                  {lookingUp
                    ? "Searching…"
                    : onlineGroups.length > 0
                      ? "Refresh part numbers"
                      : "Look up part numbers"}
                </Button>
              )}
            </div>

            {onlineGroups.length > 0 && (
              <div className="space-y-3">
                {onlineGroups.map((group) => (
                  <div
                    key={`${group.serviceId}-${group.engineVariant}`}
                    className="rounded-md border border-border p-2.5"
                  >
                    <div className="mb-2">
                      <p className="text-foreground">{group.serviceName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {group.engineVariant}
                      </p>
                    </div>
                    <div className="space-y-2">
                      {group.references.map((reference) => (
                        <div
                          key={`${reference.brand}-${reference.partNumber}-${reference.sourceUrl ?? ""}`}
                          className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] text-foreground">
                                {reference.brand} {reference.partNumber}
                              </span>
                              {reference.partType && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px]"
                                >
                                  {reference.partType === "oem"
                                    ? "OEM"
                                    : "Aftermarket"}
                                </Badge>
                              )}
                            </div>
                            {reference.fitmentNote && (
                              <p className="mt-0.5 text-[10px] text-muted-foreground">
                                {reference.fitmentNote}
                              </p>
                            )}
                          </div>
                          {reference.sourceUrl && (
                            <a
                              href={reference.sourceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                            >
                              {reference.sourceTitle || "Source"}
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {jobs.length > 0 &&
              onlineGroups.length === 0 &&
              catalogReferences.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Search OEM and reputable aftermarket sources for up to three
                  grounded matches per detected engine variant.
                </p>
              )}

            {catalogReferences.length > 0 && (
              <div className="space-y-2">
                {catalogReferences.map((reference) => (
                  <div
                    key={`${reference.serviceId}-${reference.brand}-${reference.partNumber}`}
                    className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-foreground">{reference.partName}</p>
                      {reference.serviceName !== reference.partName && (
                        <p className="text-[10px] text-muted-foreground">
                          {reference.serviceName}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 sm:text-right">
                      <p className="font-mono text-[11px] text-foreground">
                        {reference.brand} {reference.partNumber}
                      </p>
                      {reference.oemPartNumber && (
                        <p className="font-mono text-[10px] text-muted-foreground">
                          OEM {reference.oemPartNumber}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          ★ specialty tool · internal only · AI-estimated, verify on site
          {(catalogReferences.length > 0 || onlineReferences.length > 0) &&
            " · verify part fitment by VIN/engine before purchase"}
        </p>
      </CardContent>
    </Card>
  );
}
