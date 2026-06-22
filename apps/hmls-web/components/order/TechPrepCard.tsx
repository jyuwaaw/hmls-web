"use client";

import type { OrderItem } from "@hmls/shared/db/schema";
import type { Order } from "@hmls/shared/db/types";
import { AlertTriangle, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type TechPrep = NonNullable<OrderItem["techPrep"]>;

const DIFFICULTY_LABEL = [
  "",
  "Routine",
  "Easy",
  "Moderate",
  "Hard",
  "Specialist",
];

/**
 * Internal "Tech prep" panel for the shop's dispatcher / assigned mobile tech.
 * Surfaces the repair_jobs enrichment (tools, difficulty, HV-safety, notes)
 * attached to each labor line at create_order time. Renders nothing when no
 * item carries techPrep (e.g. walk-in orders, or jobs created before this).
 */
export function TechPrepCard({ order }: { order: Order }) {
  const jobs = (order.items ?? [])
    .map((it) =>
      it.techPrep ? { item: it, tp: it.techPrep as TechPrep } : null,
    )
    .filter((x): x is { item: OrderItem; tp: TechPrep } => x !== null);

  if (jobs.length === 0) return null;

  const maxDifficulty = Math.max(...jobs.map((j) => j.tp.difficulty));
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

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" /> Tech prep
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            Difficulty {maxDifficulty}/5 · {DIFFICULTY_LABEL[maxDifficulty]}
          </Badge>
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

        {/* Per-job detail */}
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

        <p className="text-[10px] text-muted-foreground">
          ★ specialty tool · internal only · AI-estimated, verify on site
        </p>
      </CardContent>
    </Card>
  );
}
