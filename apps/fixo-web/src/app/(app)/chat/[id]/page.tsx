"use client";

import type { UIMessage } from "ai";
import { redirect, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { ChatPageInner } from "@/components/chat/ChatPageInner";
import { AGENT_URL } from "@/lib/config";

interface SessionResponse {
  session: {
    id: number;
    messages: UIMessage[] | null;
    vehicleId: string | null;
    title: string | null;
    archivedAt: string | null;
  };
}

export default function ChatByIdPage() {
  const { session, user, isLoading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const sessionId = parseInt(params.id, 10);

  const [data, setData] = useState<SessionResponse["session"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.access_token || !Number.isInteger(sessionId)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${AGENT_URL}/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;
        if (res.status === 404) {
          redirect("/chat");
        }
        if (!res.ok) throw new Error(await res.text());
        const json = (await res.json()) as SessionResponse;
        setData(json.session);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, session?.access_token]);

  if (authLoading) return <Spinner />;
  if (!session || !user) redirect("/login");
  if (!Number.isInteger(sessionId)) redirect("/chat");
  if (error) return <ErrorState message={error} />;
  if (!data) return <Spinner />;

  return (
    <ChatPageInner
      key={data.id}
      session={session}
      userId={user.id}
      sessionId={data.id}
      initialMessages={data.messages ?? []}
      archived={!!data.archivedAt}
    />
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-dvh">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-dvh gap-2 text-center p-6">
      <p className="text-red-600 font-medium">Could not load chat</p>
      <p className="text-sm text-muted-foreground max-w-md">{message}</p>
    </div>
  );
}
