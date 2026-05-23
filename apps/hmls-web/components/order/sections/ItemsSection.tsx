"use client";

import { useState } from "react";
import { ItemEditor } from "@/components/order/ItemEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrderMutations } from "@/hooks/useOrderMutations";
import { formatCents } from "@/lib/format";
import type { SectionProps } from "./types";

export function ItemsSection({ order, readOnly, revalidate }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const { saveItems, savingItems } = useOrderMutations(order.id, revalidate);

  if (editing && !readOnly) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <ItemEditor
            items={order.items ?? []}
            notes={order.notes ?? ""}
            saving={savingItems}
            onSave={async (items, notes) => {
              await saveItems(items, notes);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </CardContent>
      </Card>
    );
  }

  const items = order.items ?? [];

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Line items</CardTitle>
        {!readOnly && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs space-y-1.5">
        {items.map((it) => (
          <div key={it.id} className="flex justify-between">
            <span className="text-foreground">
              <span className="text-[10px] uppercase text-muted-foreground mr-1.5">
                {it.category}
              </span>
              {it.name}
            </span>
            <span className="text-muted-foreground">
              {formatCents(it.totalCents)}
            </span>
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-muted-foreground">No items yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
