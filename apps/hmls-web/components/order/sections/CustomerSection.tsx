"use client";

import { useState } from "react";
import { CustomerEditor } from "@/components/order/CustomerEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import type { SectionProps } from "./types";

export function CustomerSection({ order, readOnly, revalidate }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const { saveCustomer, savingCustomer } = useOrderMutations(
    order.id,
    revalidate,
  );

  if (editing && !readOnly) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Customer</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <CustomerEditor
            order={{
              contactName: order.contactName ?? null,
              contactEmail: order.contactEmail ?? null,
              contactPhone: order.contactPhone ?? null,
              contactAddress: order.contactAddress ?? null,
            }}
            saving={savingCustomer}
            onSave={async (patch) => {
              await saveCustomer(patch);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Customer</CardTitle>
        {!readOnly && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-1">
        <p className="text-foreground">{order.contactName ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactPhone ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactEmail ?? "—"}</p>
        <p className="text-muted-foreground">{order.contactAddress ?? "—"}</p>
      </CardContent>
    </Card>
  );
}
