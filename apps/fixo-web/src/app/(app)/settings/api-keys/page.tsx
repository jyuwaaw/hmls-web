"use client";

import { Check, ChevronLeft, ClipboardCopy, Key, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AGENT_URL } from "@/lib/config";

interface ApiKey {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CreatedKey extends ApiKey {
  key: string;
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) {
    const hours = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60));
    if (hours === 0) return "just now";
    return `${hours}h ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ApiKeysPage() {
  const { session } = useAuth();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Create-key form state
  const [labelInput, setLabelInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke state: id → "pending" | "done" | "error"
  const [revoking, setRevoking] = useState<Record<string, "pending" | "error">>(
    {},
  );

  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    fetch(`${AGENT_URL}/keys`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: ApiKey[]) => {
        if (!cancelled) setKeys(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Failed to load API keys.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const handleCreate = async () => {
    if (!session?.access_token) return;
    setCreating(true);
    setCreateError(null);
    setNewKey(null);
    try {
      const res = await fetch(`${AGENT_URL}/keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: labelInput.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setCreateError(
          (err as { error?: string }).error ?? "Failed to create key.",
        );
        return;
      }
      const created: CreatedKey = await res.json();
      setNewKey(created);
      setLabelInput("");
      // Append to list (without the plaintext key)
      setKeys((prev) =>
        prev
          ? [
              ...prev,
              {
                id: created.id,
                label: created.label,
                createdAt: created.createdAt,
                lastUsedAt: created.lastUsedAt,
              },
            ]
          : [
              {
                id: created.id,
                label: created.label,
                createdAt: created.createdAt,
                lastUsedAt: created.lastUsedAt,
              },
            ],
      );
    } catch {
      setCreateError("Network error. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!newKey?.key) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silently ignore clipboard errors
    }
  };

  const handleRevoke = async (id: string) => {
    if (!session?.access_token) return;
    setRevoking((prev) => ({ ...prev, [id]: "pending" }));
    try {
      const res = await fetch(`${AGENT_URL}/keys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setKeys((prev) => prev?.filter((k) => k.id !== id) ?? null);
        setRevoking((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // If the revoked key is the newly created one, clear it
        if (newKey?.id === id) setNewKey(null);
      } else {
        setRevoking((prev) => ({ ...prev, [id]: "error" }));
      }
    } catch {
      setRevoking((prev) => ({ ...prev, [id]: "error" }));
    }
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-background px-4">
        <Link
          href="/settings"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Settings
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-[15px] font-semibold tracking-tight">API keys</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 pb-24">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Getting started */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Getting started
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              <div className="px-4 py-4">
                <p className="text-sm font-medium">MCP endpoint</p>
                <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  https://api.fixo.ink/v1/mcp
                </p>
              </div>
              <div className="px-4 py-3 text-[13px] text-muted-foreground">
                Add this endpoint to your MCP client with header{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
                  Authorization: Bearer &lt;your key&gt;
                </code>
              </div>
            </div>
          </section>

          {/* Create key */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Create key
            </h2>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 px-4 py-3">
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !creating) handleCreate();
                  }}
                  placeholder="Label (optional)"
                  maxLength={80}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={creating}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  <Key className="h-3 w-3" />
                  {creating ? "Creating…" : "Create key"}
                </button>
              </div>

              {createError && (
                <div className="border-t border-border px-4 py-2.5 text-xs text-red-600 dark:text-red-400">
                  {createError}
                </div>
              )}

              {/* Plaintext reveal — shown ONCE */}
              {newKey && (
                <div className="border-t border-border bg-amber-50 px-4 py-3 dark:bg-amber-900/10">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                    Copy now — you won&apos;t see this again
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded border border-amber-200 bg-white px-2.5 py-1.5 font-mono text-[13px] text-foreground dark:border-amber-900/40 dark:bg-black/30">
                      {newKey.key}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />
                          Copied
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="h-3.5 w-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Key list */}
          <section>
            <h2 className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Your keys
            </h2>

            {loadError && (
              <p className="px-1 text-sm text-red-600 dark:text-red-400">
                {loadError}
              </p>
            )}

            {!loadError && keys === null && (
              <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            )}

            {!loadError && keys !== null && keys.length === 0 && (
              <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                No API keys yet. Create one above.
              </div>
            )}

            {!loadError && keys !== null && keys.length > 0 && (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {k.label ?? (
                          <span className="italic text-muted-foreground">
                            Unnamed key
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Created {formatRelativeDate(k.createdAt)}
                        {k.lastUsedAt
                          ? ` · Last used ${formatRelativeDate(k.lastUsedAt)}`
                          : " · Never used"}
                      </p>
                      {revoking[k.id] === "error" && (
                        <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                          Revoke failed — try again
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRevoke(k.id)}
                      disabled={revoking[k.id] === "pending"}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-500 dark:hover:bg-red-900/10"
                    >
                      <Trash2 className="h-3 w-3" />
                      {revoking[k.id] === "pending" ? "Revoking…" : "Revoke"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
