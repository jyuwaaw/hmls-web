"use client";

import { redirect } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { ChatPageInner } from "@/components/chat/ChatPageInner";

export default function NewChatPage() {
  const { session, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!session || !user) redirect("/login");

  return (
    <ChatPageInner
      session={session}
      userId={user.id}
      sessionId={null}
      initialMessages={[]}
      archived={false}
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
