import type { OrderItem } from "@hmls/shared/db/types";
import { Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/lib/format";

/**
 * Numeric input that doesn't fight your typing: while focused it shows the raw
 * string you typed (so "4.", "", "-" are fine mid-edit) and commits the parsed
 * value upward on every keystroke; on blur it re-formats from the canonical value.
 */
function NumberField({
  value,
  format,
  parse,
  pattern,
  onCommit,
  inputMode,
  placeholder,
  className,
}: {
  value: number;
  format: (n: number) => string;
  parse: (s: string) => number;
  pattern: RegExp;
  onCommit: (n: number) => void;
  inputMode: "numeric" | "decimal";
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="text"
      inputMode={inputMode}
      placeholder={placeholder}
      value={draft ?? format(value)}
      onChange={(e) => {
        const v = e.target.value;
        if (!pattern.test(v)) return;
        setDraft(v);
        onCommit(parse(v));
      }}
      onFocus={(e) => e.target.select()}
      onBlur={() => setDraft(null)}
      className={className}
    />
  );
}

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
          updated.totalCents = Math.round(
            updated.quantity * updated.unitPriceCents,
          );
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
            <NumberField
              value={item.quantity}
              format={String}
              // fractional quantities are legit (2.5 hrs labor, 5.5 qt oil)
              // and exist in saved orders — keep them editable
              parse={(v) => {
                const n = Number(v);
                return n > 0 ? n : 1;
              }}
              pattern={/^\d*\.?\d{0,2}$/}
              onCommit={(quantity) => updateItem(idx, { quantity })}
              inputMode="numeric"
              placeholder="1"
              className="w-full sm:w-14 text-xs h-8 text-right"
            />
            <NumberField
              value={item.unitPriceCents}
              format={(c) => (c === 0 ? "" : (c / 100).toFixed(2))}
              parse={(v) => Math.round((Number(v) || 0) * 100)}
              // leading "-" allowed: discount items store negative cents
              pattern={/^-?\d*\.?\d{0,2}$/}
              onCommit={(unitPriceCents) => updateItem(idx, { unitPriceCents })}
              inputMode="decimal"
              placeholder="0.00"
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
