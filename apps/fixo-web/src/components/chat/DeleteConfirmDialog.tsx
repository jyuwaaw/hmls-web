"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { AGENT_URL } from "@/lib/config";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  onMutate: () => void;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  sessionId,
  onMutate,
}: Props) {
  const { session } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [deleting, setDeleting] = useState(false);

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

  const confirm = async () => {
    if (!session) return;
    setDeleting(true);
    try {
      await fetch(`${AGENT_URL}/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      onMutate();
      onOpenChange(false);
      // If we just deleted the page we're viewing, navigate away.
      if (path === `/chat/${sessionId}`) router.push("/chat");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-desc"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5">
        <h2
          id="delete-dialog-title"
          className="mb-1.5 text-base font-semibold tracking-tight"
        >
          Delete this chat?
        </h2>
        <p
          id="delete-dialog-desc"
          className="mb-5 text-[13px] leading-relaxed text-muted-foreground"
        >
          Reports and uploaded photos will be permanently deleted. This cannot
          be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={confirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}
