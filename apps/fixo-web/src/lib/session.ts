"use client";

import type { MutableRefObject } from "react";

import { AGENT_URL } from "@/lib/config";

const SESSION_ID_STORAGE_PREFIX = "fixo-chat-session-id";

// Scope by userId so a sign-out/sign-in on the same browser doesn't restore
// the previous account's session id (which the new user doesn't own — every
// /complete and /report call would 404). Anonymous fallback is for when the
// caller doesn't know the user yet; never collides with a real userId.
function storageKey(userId: string | null | undefined): string {
  return userId
    ? `${SESSION_ID_STORAGE_PREFIX}:${userId}`
    : `${SESSION_ID_STORAGE_PREFIX}:anon`;
}

const inFlight = new WeakMap<
  MutableRefObject<number | null>,
  Promise<number | null>
>();

export function persistSessionId(
  id: number,
  userId: string | null | undefined,
) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(userId), String(id));
  } catch {
    /* localStorage full or unavailable */
  }
}

/**
 * Read a previously-created Fixo session id from localStorage. Used at chat
 * mount to re-pair a restored transcript with the backend session that
 * actually owns its uploaded media. Returns null if absent or corrupt.
 */
export function loadStoredSessionId(
  userId: string | null | undefined,
): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey(userId));
    if (!stored) return null;
    const n = parseInt(stored, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Clear the persisted session id, e.g. when the user starts a new chat. */
export function clearStoredSessionId(userId: string | null | undefined) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    /* ignore */
  }
}

/**
 * Eagerly create a Fixo session on the gateway and return its id. Throws on
 * non-2xx so callers can decide whether to surface or swallow the error.
 * Used by `useAgentChat` on the first send of a new conversation so the URL
 * can upgrade to `/chat/[id]` and the gateway always has a sessionId.
 */
export async function createSessionEager(accessToken: string): Promise<number> {
  const res = await fetch(`${AGENT_URL}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = (await res.json()) as { sessionId: number };
  return data.sessionId;
}

/**
 * Resolve the current Fixo session id, lazily creating one on the gateway if
 * none exists. Concurrent callers share the same in-flight promise so we
 * never POST /sessions twice for the same ref.
 *
 * @deprecated Prefer `createSessionEager` for new call sites — the chat hook
 * now eagerly creates the session on first send, so this lazy variant only
 * exists for legacy upload/report paths that still need the ref-based
 * write-through + persistence behavior.
 */
export async function ensureSession(
  accessToken: string,
  sessionIdRef: MutableRefObject<number | null>,
  userId: string | null | undefined,
): Promise<number | null> {
  if (sessionIdRef.current) return sessionIdRef.current;

  const existing = inFlight.get(sessionIdRef);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const id = await createSessionEager(accessToken);
      sessionIdRef.current = id;
      // Persist so a refresh that restores the chat transcript also re-pairs
      // it with the same backend session — otherwise media hydration on
      // /complete looks at a fresh empty session.
      persistSessionId(id, userId);
      return id;
    } catch {
      return null;
    }
  })();

  inFlight.set(sessionIdRef, promise);
  void promise.finally(() => inFlight.delete(sessionIdRef));
  return promise;
}
