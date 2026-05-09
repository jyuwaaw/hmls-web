"use client";

import { Check, ClipboardCopy, FileText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  FixoEstimateData,
  FixoEstimateItemTier,
} from "@/hooks/useAgentChat";

interface FixoEstimateCardProps {
  data: FixoEstimateData;
}

type EstimateItem = FixoEstimateData["items"][number];

// Display order: most-urgent first so customers see required work before optional
const TIER_ORDER: FixoEstimateItemTier[] = [
  "required",
  "recommended",
  "maintenance",
  "optional",
];

const TIER_LABELS: Record<FixoEstimateItemTier, string> = {
  required: "Required",
  recommended: "Recommended",
  maintenance: "Maintenance",
  optional: "Optional",
};

const TIER_BADGE_CLASS: Record<FixoEstimateItemTier, string> = {
  required:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400",
  recommended:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-400",
  maintenance:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/40 dark:bg-sky-900/20 dark:text-sky-400",
  optional: "border-border bg-muted text-muted-foreground",
};

function groupItemsByTier(items: EstimateItem[]): Array<{
  tier: FixoEstimateItemTier | "untiered";
  items: EstimateItem[];
}> {
  const buckets = new Map<FixoEstimateItemTier | "untiered", EstimateItem[]>();
  for (const item of items) {
    const key = item.tier ?? "untiered";
    const existing = buckets.get(key);
    if (existing) existing.push(item);
    else buckets.set(key, [item]);
  }
  // Stable order: TIER_ORDER first, then untiered
  const result: Array<{
    tier: FixoEstimateItemTier | "untiered";
    items: EstimateItem[];
  }> = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (bucket && bucket.length > 0) result.push({ tier, items: bucket });
  }
  const untiered = buckets.get("untiered");
  if (untiered && untiered.length > 0)
    result.push({ tier: "untiered", items: untiered });
  return result;
}

export function FixoEstimateCard({ data }: FixoEstimateCardProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = data.shareToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/estimate/${data.shareToken}`
    : null;

  const handleShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: silently ignore clipboard errors
    }
  };

  return (
    <Card className="w-full overflow-hidden border-border bg-card shadow-none">
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <FileText
              className="h-3.5 w-3.5 text-foreground"
              strokeWidth={1.75}
            />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm font-semibold tracking-tight">
              Estimate
              {data.estimateId ? (
                <span className="ml-1 font-mono text-xs tabular-nums text-muted-foreground">
                  #{data.estimateId}
                </span>
              ) : null}
            </CardTitle>
            <p className="truncate text-xs text-muted-foreground">
              {data.vehicle}
            </p>
          </div>
          {data.note && (
            <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-400">
              Not saved
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 py-3">
        {groupItemsByTier(data.items).map((group) => (
          <div key={group.tier} className="space-y-1.5">
            {group.tier !== "untiered" && (
              <div className="flex items-center gap-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    TIER_BADGE_CLASS[group.tier]
                  }`}
                >
                  {TIER_LABELS[group.tier]}
                </span>
              </div>
            )}
            {group.items.map((item, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: items have no stable id
                key={i}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">
                    {item.name}
                  </span>
                  {item.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </div>
                <span className="shrink-0 font-mono font-medium tabular-nums">
                  ${(item.unitPrice * item.quantity).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-2.5 border-t border-border bg-muted/40">
        <div className="flex justify-between pt-1 text-sm">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-mono font-semibold tabular-nums">
            ${data.subtotal.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Estimated range</span>
          <span className="self-center font-mono text-base font-semibold leading-none tabular-nums text-accent">
            {data.priceRange}
          </span>
        </div>
        {data.expiresAt && (
          <p className="text-xs text-muted-foreground">
            Valid until{" "}
            <span className="tabular-nums">
              {new Date(data.expiresAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </p>
        )}
        {shareUrl && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 w-full border-border bg-card hover:bg-muted"
            onClick={handleShare}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <ClipboardCopy className="h-3.5 w-3.5" />
                Share estimate
              </>
            )}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
