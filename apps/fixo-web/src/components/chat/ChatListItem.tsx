"use client";

import { MoreVertical } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { RenameDialog } from "./RenameDialog";

interface Props {
  session: {
    id: number;
    title: string | null;
    archivedAt: string | null;
    lastMessageAt: string;
  };
  onMutate: () => void;
}

export function ChatListItem({ session, onMutate }: Props) {
  const path = usePathname();
  const isActive = path === `/chat/${session.id}`;
  const { session: authSession } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  const archive = async () => {
    if (!authSession) return;
    await fetch(`${AGENT_URL}/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${authSession.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        archivedAt: session.archivedAt ? null : new Date().toISOString(),
      }),
    });
    onMutate();
  };

  const titleText = session.title ?? "Untitled";

  return (
    <div className="group relative" ref={menuRef}>
      <div
        className={`flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-muted/60 ${
          isActive ? "bg-muted" : ""
        } ${session.archivedAt ? "opacity-60" : ""}`}
      >
        <Link
          href={`/chat/${session.id}`}
          className="flex-1 truncate text-foreground"
        >
          {titleText}
        </Link>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            setMenuOpen((o) => !o);
          }}
          aria-label={`Actions for ${titleText}`}
          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>
      {menuOpen && (
        <div className="absolute right-2 top-full z-20 mt-1 flex w-32 flex-col rounded-md border border-border bg-popover shadow-md">
          <button
            type="button"
            className="px-3 py-1.5 text-left text-[12px] hover:bg-muted"
            onClick={() => {
              setMenuOpen(false);
              setRenameOpen(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-left text-[12px] hover:bg-muted"
            onClick={() => {
              setMenuOpen(false);
              archive();
            }}
          >
            {session.archivedAt ? "Unarchive" : "Archive"}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-left text-[12px] text-destructive hover:bg-destructive/10"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            Delete
          </button>
        </div>
      )}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={session.id}
        currentTitle={titleText}
        onMutate={onMutate}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        sessionId={session.id}
        onMutate={onMutate}
      />
    </div>
  );
}
