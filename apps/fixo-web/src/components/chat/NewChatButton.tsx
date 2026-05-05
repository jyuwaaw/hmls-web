"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";

export function NewChatButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push("/chat")}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
      aria-label="New chat"
    >
      <Plus className="h-3 w-3" />
      New chat
    </button>
  );
}
