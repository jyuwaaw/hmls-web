"use client";

import type { Session } from "@supabase/supabase-js";
import {
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  type UIMessage,
} from "ai";
import { Car, FileDown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ChatInput } from "@/components/chat/ChatInput";
import { FixoEstimateCard } from "@/components/chat/FixoEstimateCard";
import { renderToolCard } from "@/components/chat/tool-cards";
import { AudioRecorder } from "@/components/media/AudioRecorder";
import { CameraCapture } from "@/components/media/CameraCapture";
import { ObdInput } from "@/components/media/ObdInput";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useMediaUpload } from "@/hooks/useMediaUpload";
import { AGENT_URL } from "@/lib/config";
import { downloadReportPdf } from "@/lib/download-report";
import { ensureSession } from "@/lib/session";

function WelcomeScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-card">
        <Car className="h-5 w-5 text-foreground" strokeWidth={1.75} />
      </div>
      <h2 className="mb-2 text-base font-semibold tracking-tight text-accent">
        Fixo<span className="text-accent-hover">.</span>
      </h2>
      <p className="max-w-xs text-[13px] leading-relaxed text-muted-foreground">
        Describe your car problem, snap a photo of a warning light, or enter an
        OBD code for instant expert analysis.
      </p>
    </div>
  );
}

interface ChatPageInnerProps {
  session: Session;
  userId: string;
  sessionId: number | null;
  initialMessages: UIMessage[];
  archived: boolean;
}

export function ChatPageInner({
  session,
  userId,
  sessionId,
  initialMessages,
  archived,
}: ChatPageInnerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Seed the ref synchronously on first render so the chat transport's first
  // /task call already carries the resolved sessionId. Doing this in an
  // effect would race with an immediate sendMessage on a resumed transcript.
  const sessionIdRef = useRef<number | null>(sessionId);
  const [showCamera, setShowCamera] = useState(false);
  const [showAudioRecorder, setShowAudioRecorder] = useState(false);
  const [showObdInput, setShowObdInput] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);

  const {
    uiMessages,
    isLoading,
    status,
    sendMessage,
    pendingEstimate,
    error,
    clearError,
    getImageUrl,
  } = useAgentChat({
    scrollRef,
    inputRef,
    accessToken: session.access_token,
    sessionIdRef,
    userId,
    initialMessages,
    initialSessionId: sessionId,
  });

  const [isFinalizing, setIsFinalizing] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactToast, setCompactToast] = useState<string | null>(null);

  const handleCompact = useCallback(async () => {
    if (!sessionIdRef.current) return;
    setIsCompacting(true);
    try {
      const res = await fetch(
        `${AGENT_URL}/sessions/${sessionIdRef.current}/compact`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setCompactToast(`Compacted ${data.messagesFolded ?? 0} messages.`);
      setTimeout(() => setCompactToast(null), 4000);
    } catch (e) {
      setCompactToast(e instanceof Error ? e.message : "Compact failed.");
      setTimeout(() => setCompactToast(null), 4000);
    } finally {
      setIsCompacting(false);
    }
  }, [session.access_token]);

  const { handleAudioSend, handlePhotoCapture, handleFilePick } =
    useMediaUpload({
      accessToken: session.access_token,
      sessionIdRef,
      sendMessage,
      userId,
      // Free-tier users get a 403 from /sessions/:id/input on photo/audio.
      // Route that to the same UpgradeModal the chat error path uses so the
      // user sees a real explanation instead of a generic "upload failed".
      onUpgradeRequired: setUpgradeMessage,
    });

  const handleDownloadReport = useCallback(async () => {
    if (isFinalizing) return;
    setReportError(null);
    setIsFinalizing(true);
    try {
      // Lazy session creation: text-only chats don't have a session id until
      // the user actually needs one. The Report click is that moment. This
      // keeps the free-tier session-count quota gated on report generation,
      // not on every chat send.
      const sid = await ensureSession(
        session.access_token,
        sessionIdRef,
        userId,
      );
      if (!sid) throw new Error("Failed to start a session");

      // Finalize the session first: this calls generateObject server-side and
      // populates fixo_sessions.result + status='complete'. The chat history
      // lives in client state, so we must hand it to the server explicitly.
      const completeRes = await fetch(`${AGENT_URL}/sessions/${sid}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ messages: uiMessages }),
      });
      if (!completeRes.ok) {
        const detail = await completeRes
          .json()
          .catch(() => ({ error: completeRes.statusText }));
        throw new Error(detail.error ?? "Failed to finalize session");
      }
      const { reportId } = (await completeRes.json()) as { reportId: string };

      await downloadReportPdf(reportId, session.access_token);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsFinalizing(false);
    }
  }, [session.access_token, uiMessages, isFinalizing, userId]);

  const handleObdSubmit = useCallback(
    (codes: string[]) => {
      sendMessage(`OBD-II Codes: ${codes.join(", ")}`);
    },
    [sendMessage],
  );

  // Check for upgrade-related errors from the agent
  const isUpgradeError =
    error &&
    (error.includes("upgrade_required") || error.includes("limit_reached"));

  // Move state update out of render to avoid React anti-pattern
  useEffect(() => {
    if (isUpgradeError && !upgradeMessage) {
      setUpgradeMessage(error);
      clearError();
    }
  }, [isUpgradeError, error, upgradeMessage, clearError]);

  // Filter out empty (no-text, no-tool) messages so a transient assistant
  // chunk before the model emits anything doesn't render an empty bubble.
  const renderable = uiMessages.filter((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    return msg.parts.some(
      (p) =>
        (p.type === "text" && p.text.trim().length > 0) ||
        p.type === "reasoning" ||
        isToolOrDynamicToolUIPart(p),
    );
  });

  return (
    <div className="flex flex-col h-dvh">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-md">
        {/* Mobile: "Fixo." logo (no sidebar to host it).
            Desktop: page title "Chat" matches the other pages — sidebar
            already shows the logo so repeating it here read as duplication. */}
        <h1 className="flex items-center text-[15px] font-semibold tracking-tight">
          <span className="text-accent lg:hidden">
            Fixo<span className="text-accent-hover">.</span>
          </span>
          <span className="hidden lg:inline">Chat</span>
          {archived && (
            <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              Archived
            </span>
          )}
        </h1>
        {renderable.length > 0 && !isLoading && (
          <div className="flex items-center gap-2">
            {sessionIdRef.current && (
              <button
                type="button"
                disabled={isCompacting}
                onClick={handleCompact}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="Compact context"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {isCompacting ? "Compacting…" : "Clean up"}
              </button>
            )}
            <button
              type="button"
              disabled={isFinalizing}
              onClick={handleDownloadReport}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Finish session and download report"
            >
              <FileDown className="h-3.5 w-3.5" />
              {isFinalizing ? "Generating…" : "Report"}
            </button>
          </div>
        )}
      </header>

      {/* Messages — AI Elements <Conversation> handles stick-to-bottom and the
          floating "scroll to latest" button without us re-implementing it. */}
      <Conversation className="flex-1 pb-36">
        <ConversationContent>
          {renderable.length === 0 && <WelcomeScreen />}
          {renderable.map((msg, idx) => {
            const isLastAssistant =
              idx === renderable.length - 1 && msg.role === "assistant";
            const previewImage =
              msg.role === "user" ? getImageUrl(msg.id) : undefined;

            // Detect if a later user message has already responded to this
            // assistant turn's ask_user_question. The agent's prompt asks one
            // question at a time, so the immediate next user message IS the
            // answer (regardless of which option button was tapped vs. typed).
            const nextUserMsg =
              msg.role === "assistant"
                ? renderable.slice(idx + 1).find((m) => m.role === "user")
                : undefined;
            const nextUserAnswer = nextUserMsg?.parts.find(
              (p): p is { type: "text"; text: string } => p.type === "text",
            )?.text;

            return (
              // AI SDK v6 sometimes pushes intermediate messages without an
              // id during streaming (empty-string assistant stubs). Two of
              // those land in `renderable` and React sees `key=""` twice.
              // Falling back to the array index for missing ids keeps the
              // sibling list disambiguated without changing identity for
              // properly-id'd messages.
              <Message from={msg.role} key={msg.id || `idx-${idx}`}>
                <MessageContent>
                  {previewImage && (
                    // biome-ignore lint/performance/noImgElement: data URL preview, not a static asset
                    <img
                      alt="Uploaded"
                      className="rounded-lg max-w-full"
                      src={previewImage}
                    />
                  )}
                  {msg.parts.map((part, i) => {
                    const partKey = `${msg.id}-${i}`;
                    if (part.type === "text") {
                      return (
                        <MessageResponse
                          isAnimating={isLastAssistant && isLoading}
                          key={partKey}
                        >
                          {part.text}
                        </MessageResponse>
                      );
                    }
                    if (part.type === "reasoning") {
                      return (
                        <Reasoning
                          isStreaming={isLastAssistant && isLoading}
                          key={partKey}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    if (isToolOrDynamicToolUIPart(part)) {
                      // Custom card if we have one for this tool name —
                      // ObdCode / Labor / Parts / VehicleServices / AskUser.
                      const card = renderToolCard(part, {
                        isAnswered: !!nextUserAnswer,
                        answer: nextUserAnswer,
                        onAnswer: sendMessage,
                      });
                      if (card) {
                        return (
                          <div key={partKey} className="px-1">
                            {card}
                          </div>
                        );
                      }
                      // Fallback: generic AI Elements <Tool> for tools we
                      // haven't designed a card for yet.
                      const headerProps =
                        part.type === "dynamic-tool"
                          ? {
                              type: "dynamic-tool" as const,
                              state: part.state,
                              toolName: getToolOrDynamicToolName(part),
                            }
                          : { type: part.type, state: part.state };
                      return (
                        <Tool key={partKey}>
                          <ToolHeader {...headerProps} />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            {(part.state === "output-available" ||
                              part.state === "output-error") && (
                              <ToolOutput
                                errorText={
                                  part.state === "output-error"
                                    ? part.errorText
                                    : undefined
                                }
                                output={
                                  part.state === "output-available"
                                    ? part.output
                                    : undefined
                                }
                              />
                            )}
                          </ToolContent>
                        </Tool>
                      );
                    }
                    return null;
                  })}
                </MessageContent>
              </Message>
            );
          })}
          {/* Thinking indicator: visible only on `submitted` — the gap between
              the user pressing send and the first token arriving. Once `streaming`
              starts, Streamdown's caret + tool cards take over and an extra
              spinner becomes redundant noise. Vercel AI SDK's recommended
              pattern is exactly this: gate on `status === "submitted"`. */}
          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent>
                <Shimmer baseColor="var(--color-accent)">Thinking…</Shimmer>
              </MessageContent>
            </Message>
          )}
          {pendingEstimate && (
            <div className="px-1">
              <FixoEstimateCard data={pendingEstimate} />
            </div>
          )}
          {error && !isUpgradeError && (
            <div className="text-center text-sm text-red-500 py-2">{error}</div>
          )}
          {reportError && (
            <div className="text-center text-sm text-red-500 py-2">
              {reportError}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        isLoading={isLoading}
        inputRef={inputRef}
        onCameraClick={() => setShowCamera(true)}
        onMicClick={() => setShowAudioRecorder(true)}
        onObdClick={() => setShowObdInput(true)}
        onFilePick={handleFilePick}
      />

      {/* Camera overlay */}
      {showCamera && (
        <CameraCapture
          onCapture={handlePhotoCapture}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Audio recorder */}
      {showAudioRecorder && (
        <AudioRecorder
          onSend={handleAudioSend}
          onClose={() => setShowAudioRecorder(false)}
        />
      )}

      {/* OBD input */}
      {showObdInput && (
        <ObdInput
          onSubmit={handleObdSubmit}
          onClose={() => setShowObdInput(false)}
        />
      )}

      {/* Upgrade modal */}
      {upgradeMessage && (
        <UpgradeModal
          message={upgradeMessage}
          onClose={() => setUpgradeMessage(null)}
        />
      )}

      {/* Compact toast */}
      {compactToast && (
        <div className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-md">
          {compactToast}
        </div>
      )}
    </div>
  );
}
