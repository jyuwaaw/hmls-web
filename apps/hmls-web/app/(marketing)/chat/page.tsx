"use client";

import { isToolOrDynamicToolUIPart } from "ai";
import { motion, useReducedMotion } from "framer-motion";
import { Wrench } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { useAgentChat } from "@/hooks/useAgentChat";

const SUGGESTIONS = [
  "What services do you offer?",
  "I need an oil change",
  "Check availability",
  "Get a quote for brake service",
];

function WelcomeScreen({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className="w-16 h-16 rounded-full bg-red-light flex items-center justify-center mb-4"
      >
        <Wrench className="w-8 h-8 text-red-primary" />
      </motion.div>
      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-xl font-display font-bold text-text mb-2"
      >
        Welcome to HMLS Assistant
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="text-text-secondary max-w-md"
      >
        I can help you with scheduling appointments, getting quotes, checking
        service availability, and answering questions about our mobile mechanic
        services.
      </motion.p>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-6"
      >
        <Suggestions>
          {SUGGESTIONS.map((suggestion) => (
            <Suggestion
              key={suggestion}
              suggestion={suggestion}
              onSuggestionClick={onPick}
            />
          ))}
        </Suggestions>
      </motion.div>
    </div>
  );
}

function ChatPageInner() {
  const prefersReducedMotion = useReducedMotion();
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === "true";

  // Redirect unauthenticated visitors to /login so they never hit the
  // gateway's 401 on send. Admins go to /admin/chat — gateway 403s otherwise.
  // NEXT_PUBLIC_SKIP_AUTH=true bypasses for local dev.
  useEffect(() => {
    if (skipAuth) return;
    if (authLoading) return;
    if (!session) {
      router.replace("/login");
      return;
    }
    if (isAdmin) {
      router.replace("/admin/chat");
    }
  }, [skipAuth, authLoading, session, isAdmin, router]);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasSentInitial = useRef(false);

  const {
    uiMessages,
    isLoading,
    error,
    sendMessage,
    clearMessages,
    clearError,
  } = useAgentChat({
    accessToken: session?.access_token,
    inputRef,
  });

  // Focus input on mount only (avoid autoFocus on every state change for mobile).
  useEffect(() => {
    const isMobile = window.matchMedia("(pointer: coarse)").matches;
    if (!isMobile) {
      inputRef.current?.focus();
    }
  }, []);

  // Lock html + body overflow while chat is mounted so the in-page
  // Conversation is the only scroll surface — marketing layout's flex
  // wrappers + navbar borders would otherwise push total content past
  // 100dvh by a few pixels and produce a redundant outer scrollbar at
  // the browser viewport edge. Restored on unmount.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  // Auto-send initial message from query params (hero widget).
  useEffect(() => {
    if (hasSentInitial.current || uiMessages.length > 0) return;
    const service = searchParams.get("service");
    const date = searchParams.get("date");
    const location = searchParams.get("location");

    if (service || date || location) {
      hasSentInitial.current = true;
      const parts: string[] = [];
      if (service)
        parts.push(
          `I need ${/^[aeiou]/i.test(service) ? "an" : "a"} ${service}`,
        );
      if (date) {
        const formatted = new Date(`${date}T00:00:00`).toLocaleDateString(
          "en-US",
          { weekday: "long", month: "long", day: "numeric" },
        );
        parts.push(`on ${formatted}`);
      }
      if (location) parts.push(`near ${location}`);
      sendMessage(`${parts.join(" ")}.`);
    }
  }, [searchParams, uiMessages.length, sendMessage]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput("");
  };

  // Filter out empty messages so a transient assistant chunk before the
  // model emits anything doesn't render an empty bubble. Reasoning parts
  // are intentionally skipped — customer chat hides chain-of-thought.
  const renderable = useMemo(
    () =>
      uiMessages.filter((msg) => {
        if (msg.role !== "user" && msg.role !== "assistant") return false;
        return msg.parts.some(
          (p) =>
            (p.type === "text" && p.text.trim().length > 0) ||
            isToolOrDynamicToolUIPart(p),
        );
      }),
    [uiMessages],
  );

  // Map each assistant message id to the text of the first user message
  // that follows it. Replaces an O(n²) slice+find inside the render loop.
  const nextUserAnswerByAssistantId = useMemo(() => {
    const map = new Map<string, string>();
    let pendingAssistantIds: string[] = [];
    for (const msg of renderable) {
      if (msg.role === "assistant") {
        pendingAssistantIds.push(msg.id);
      } else if (msg.role === "user") {
        const text = msg.parts.find(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )?.text;
        if (text) {
          for (const id of pendingAssistantIds) map.set(id, text);
        }
        pendingAssistantIds = [];
      }
    }
    return map;
  }, [renderable]);

  // Show loading state while auth resolves, or while redirecting
  // unauthenticated users to /login / admins to /admin/chat.
  if (!skipAuth && (authLoading || !session || isAdmin)) {
    return (
      <main className="flex flex-col flex-1 bg-background text-text">
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="text-red-primary animate-pulse">Loading...</div>
        </div>
      </main>
    );
  }

  // ChatGPT-style full-bleed: main covers the entire viewport (fixed
  // inset-0) so the inner Conversation scrollbar runs from the very top
  // to the very bottom of the window. The marketing navbar (sticky top-0,
  // z-50) sits on top of main, and messages scroll *under* it. The chat's
  // own header and the PromptInput are also positioned absolutely over
  // the Conversation, with bg fades so messages disappear cleanly behind
  // them — Conversation owns the entire scroll surface.
  //
  // Padding inside ConversationContent reserves space for the overlay
  // bars: pt clears the navbar (4rem) + chat header (~5rem) + breathing,
  // pb clears the input box (~6rem) + breathing.
  return (
    <main className="fixed inset-0 z-0 bg-background text-text overflow-hidden">
      <Conversation className="absolute inset-0">
        <ConversationContent className="px-4 sm:px-6 pt-[calc(4rem+5rem+4rem)] pb-[calc(6rem+3rem)] max-w-5xl mx-auto w-full">
          {renderable.length === 0 && <WelcomeScreen onPick={sendMessage} />}
          {renderable.map((msg, idx) => {
            const isLastAssistant =
              idx === renderable.length - 1 && msg.role === "assistant";
            const nextUserAnswer =
              msg.role === "assistant"
                ? nextUserAnswerByAssistantId.get(msg.id)
                : undefined;
            return (
              <ChatMessage
                key={msg.id}
                msg={msg}
                isStreaming={isLastAssistant && isLoading}
                nextUserAnswer={nextUserAnswer}
                onAnswer={sendMessage}
                mode="customer"
                hideReasoning
                hideGenericToolFallback
              />
            );
          })}

          {/* Submitted-state indicator: bridges the gap between user
                send and first assistant token / tool call so the chat
                doesn't feel frozen. */}
          {isLoading &&
            (renderable.length === 0 ||
              renderable[renderable.length - 1]?.role === "user") && (
              <Message from="assistant">
                <MessageAvatar aria-hidden>
                  <Wrench className="h-4 w-4" />
                </MessageAvatar>
                <MessageContent>
                  <Loader label="Working on it…" />
                </MessageContent>
              </Message>
            )}

          {error && (
            <div className="rounded-2xl bg-red-50 border border-red-200 px-5 py-3">
              <p className="text-xs font-medium text-red-600 mb-1">Error</p>
              <p className="text-sm text-red-700">{error}</p>
              <button
                type="button"
                onClick={clearError}
                className="text-xs text-red-500 hover:text-red-700 mt-1 underline"
              >
                Dismiss
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Floating chat header — sits below the marketing navbar, above
          the scrolling Conversation. Solid bg so messages don't bleed
          through, gradient fade below softens the seam. */}
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.4 }}
        className="absolute left-0 right-0 top-[4rem] z-10 px-4 sm:px-6 pb-10 bg-gradient-to-b from-background via-background to-transparent [contain:layout_paint] will-change-transform"
      >
        <div className="flex items-center justify-between max-w-5xl mx-auto w-full pt-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-red-light flex items-center justify-center">
              <Wrench className="w-6 h-6 text-red-primary" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold text-text">
                HMLS Assistant
              </h1>
              <p className="text-sm text-text-secondary">
                Online — Ready to help
              </p>
            </div>
          </div>
          <motion.button
            type="button"
            onClick={async () => {
              if (
                uiMessages.length === 0 ||
                (await askConfirm({
                  title: "Clear chat history?",
                  description: "This removes all messages from this device.",
                  confirmLabel: "Clear",
                  destructive: true,
                }))
              ) {
                clearMessages();
              }
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="text-sm text-text-secondary hover:text-text transition-colors px-4 py-2 rounded-lg hover:bg-surface-alt"
          >
            Clear chat
          </motion.button>
        </div>
      </motion.div>

      {/* Floating input box — pinned to the bottom of the viewport with
          a top gradient that fades messages out behind it. */}
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          prefersReducedMotion ? { duration: 0 } : { duration: 0.4, delay: 0.2 }
        }
        className="absolute left-0 right-0 bottom-0 z-10 px-4 sm:px-6 pt-6 pb-4 bg-gradient-to-t from-background via-background to-transparent [contain:layout_paint] will-change-transform"
      >
        <div className="max-w-5xl mx-auto w-full">
          <PromptInput onSubmit={handleSubmit}>
            <label htmlFor="chat-input" className="sr-only">
              Chat message
            </label>
            <PromptInputTextarea
              ref={inputRef}
              id="chat-input"
              name="message"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onSubmitOnEnter={() => {
                if (!input.trim() || isLoading) return;
                sendMessage(input.trim());
                setInput("");
              }}
              placeholder="Type your message..."
            />
            <PromptInputToolbar>
              <span className="pl-2 text-[11px] text-text-secondary/60">
                Enter to send · Shift+Enter for newline
              </span>
              <PromptInputSubmit disabled={isLoading || !input.trim()} />
            </PromptInputToolbar>
          </PromptInput>
        </div>
      </motion.div>
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <main className="flex flex-col flex-1 bg-background text-text">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-red-primary animate-pulse">Loading...</div>
          </div>
        </main>
      }
    >
      <ChatPageInner />
    </Suspense>
  );
}
