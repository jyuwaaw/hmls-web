"use client";

import { X } from "lucide-react";
import { useState } from "react";

interface AddVehicleModalProps {
  error: string | null;
  onClose: () => void;
  onAdd: (data: {
    year: string;
    make: string;
    model: string;
    nickname: string;
  }) => void;
}

export function AddVehicleModal({
  error,
  onClose,
  onAdd,
}: AddVehicleModalProps) {
  const [formData, setFormData] = useState({
    year: "",
    make: "",
    model: "",
    nickname: "",
  });

  const inputClass =
    "w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 transition-colors focus:border-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-t-xl border-t border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-semibold tracking-tight">
            Add vehicle
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mb-5 space-y-2.5">
          <input
            type="number"
            placeholder="Year (optional)"
            value={formData.year}
            onChange={(e) => setFormData({ ...formData, year: e.target.value })}
            className={inputClass}
          />
          <input
            type="text"
            placeholder="Make (e.g. Toyota)"
            value={formData.make}
            onChange={(e) => setFormData({ ...formData, make: e.target.value })}
            className={inputClass}
          />
          <input
            type="text"
            placeholder="Model (e.g. Camry)"
            value={formData.model}
            onChange={(e) =>
              setFormData({ ...formData, model: e.target.value })
            }
            className={inputClass}
          />
          <input
            type="text"
            placeholder="Nickname (optional)"
            value={formData.nickname}
            onChange={(e) =>
              setFormData({ ...formData, nickname: e.target.value })
            }
            className={inputClass}
          />
        </div>

        <button
          type="button"
          onClick={() => onAdd(formData)}
          disabled={!formData.make || !formData.model}
          className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          Add vehicle
        </button>
      </div>
    </div>
  );
}
