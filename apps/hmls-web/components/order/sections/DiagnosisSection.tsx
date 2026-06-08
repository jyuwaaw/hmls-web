"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import type { SectionProps } from "./types";

/**
 * The mechanic's confirmed diagnosis — "what it actually turned out to be"
 * after the on-site visit. Paired with the customer's original complaint
 * (order_intake.symptom_description) this is the labeled ground-truth half of
 * the diagnostic loop. Editable in in_progress / completed (see STATUS_PROFILES).
 */
export function DiagnosisSection({
  order,
  readOnly,
  revalidate,
}: SectionProps) {
  const { saveConfirmedDiagnosis, savingDiagnosis } = useOrderMutations(
    order.id,
    revalidate,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(order.confirmedDiagnosis ?? "");

  // Nothing to show and nothing the admin can add at this status — hide it.
  if (readOnly && !order.confirmedDiagnosis) return null;

  if (editing && !readOnly) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4">
          <CardTitle className="text-sm">Confirmed diagnosis</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What did it actually turn out to be? (the real fault confirmed on-site)"
            rows={3}
            className="text-xs"
          />
          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="xs"
              disabled={savingDiagnosis}
              onClick={() => {
                setDraft(order.confirmedDiagnosis ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={savingDiagnosis}
              onClick={async () => {
                await saveConfirmedDiagnosis(draft.trim());
                setEditing(false);
              }}
            >
              {savingDiagnosis ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Confirmed diagnosis</CardTitle>
        {!readOnly && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(order.confirmedDiagnosis ?? "");
              setEditing(true);
            }}
          >
            {order.confirmedDiagnosis ? "Edit" : "Add"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs">
        {order.confirmedDiagnosis ? (
          <p className="text-foreground whitespace-pre-wrap">
            {order.confirmedDiagnosis}
          </p>
        ) : (
          <p className="text-muted-foreground">
            Not recorded yet — log what the issue actually turned out to be.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
