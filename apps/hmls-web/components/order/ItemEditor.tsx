import type { OrderItem } from "@hmls/shared/db/types";
import { Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/lib/format";

export function ItemEditor({
  items,
  notes,
  onSave,
  onCancel,
  saving,
}: {
  items: OrderItem[];
  notes: string | null;
  onSave: (items: OrderItem[], notes: string) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [editItems, setEditItems] = useState<OrderItem[]>(
    items.length > 0 ? items : [],
  );
  const [editNotes, setEditNotes] = useState(notes ?? "");

  function updateItem(index: number, patch: Partial<OrderItem>) {
    setEditItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        const updated = { ...item, ...patch };
        if ("quantity" in patch || "unitPriceCents" in patch) {
          updated.totalCents = updated.quantity * updated.unitPriceCents;
        }
        return updated;
      }),
    );
  }

  return (
    <div className="border border-border rounded-lg p-4 bg-muted space-y-3">
      <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
        Edit Items
      </h4>

      {editItems.map((item, idx) => (
        <div
          key={item.id}
          className="space-y-1.5 border-b border-border pb-2 last:border-0"
        >
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-2">
            <select
              value={item.category}
              onChange={(e) =>
                updateItem(idx, {
                  category: e.target.value as OrderItem["category"],
                })
              }
              className="text-xs h-8 rounded-md border border-input bg-transparent px-2 py-1.5"
            >
              <option value="labor">Labor</option>
              <option value="parts">Parts</option>
              <option value="fee">Fee</option>
              <option value="discount">Discount</option>
            </select>
            <Input
              type="text"
              placeholder="Name"
              value={item.name}
              onChange={(e) => updateItem(idx, { name: e.target.value })}
              className="min-w-0 text-xs h-8"
            />
            <Input
              type="number"
              min={1}
              value={item.quantity}
              onChange={(e) =>
                updateItem(idx, { quantity: Number(e.target.value) || 1 })
              }
              className="w-full sm:w-14 text-xs h-8 text-right"
            />
            <Input
              type="number"
              min={0}
              step={0.01}
              placeholder="$"
              value={(item.unitPriceCents / 100).toFixed(2)}
              onChange={(e) =>
                updateItem(idx, {
                  unitPriceCents: Math.round(
                    (Number(e.target.value) || 0) * 100,
                  ),
                })
              }
              className="w-full sm:w-24 text-xs h-8 text-right"
            />
            <span className="text-xs text-muted-foreground w-16 text-right">
              {formatCents(item.quantity * item.unitPriceCents)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                setEditItems((prev) => prev.filter((_, i) => i !== idx))
              }
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
          <Input
            type="text"
            placeholder="Description (optional — shown on the estimate)"
            value={item.description ?? ""}
            onChange={(e) =>
              updateItem(idx, { description: e.target.value || undefined })
            }
            className="w-full text-xs h-8"
          />
        </div>
      ))}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          setEditItems((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              category: "labor",
              name: "",
              description: "",
              quantity: 1,
              unitPriceCents: 0,
              totalCents: 0,
              taxable: true,
            },
          ])
        }
        className="text-muted-foreground"
      >
        <Plus className="w-3.5 h-3.5" /> Add item
      </Button>

      <div>
        <label
          htmlFor="item-editor-notes"
          className="text-xs font-medium text-muted-foreground block mb-1"
        >
          Notes
        </label>
        <Textarea
          id="item-editor-notes"
          value={editNotes}
          onChange={(e) => setEditNotes(e.target.value)}
          rows={2}
          className="text-xs min-h-0 resize-y"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onSave(editItems, editNotes)}
          disabled={saving}
        >
          <Save className="w-3.5 h-3.5" /> {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
