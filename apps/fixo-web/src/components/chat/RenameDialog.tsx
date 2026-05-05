"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { AGENT_URL } from "@/lib/config";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  currentTitle: string;
  onMutate: () => void;
}

export function RenameDialog({
  open,
  onOpenChange,
  sessionId,
  currentTitle,
  onMutate,
}: Props) {
  const { session } = useAuth();
  const [title, setTitle] = useState(currentTitle);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset local state and focus input whenever the dialog opens
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      // Defer focus to after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, currentTitle]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, onOpenChange]);

  if (!open) return null;

  const trimmed = title.trim();

  const save = async () => {
    if (!session || !trimmed) return;
    setSaving(true);
    try {
      await fetch(`${AGENT_URL}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: trimmed }),
      });
      onMutate();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-dialog-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5">
        <h2
          id="rename-dialog-title"
          className="mb-3 text-base font-semibold tracking-tight"
        >
          Rename chat
        </h2>
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !saving) save();
          }}
          className="mb-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/50"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !trimmed}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
