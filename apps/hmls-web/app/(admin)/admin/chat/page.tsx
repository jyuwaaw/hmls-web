"use client";

import { isToolOrDynamicToolUIPart } from "ai";
import { Wrench } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { useAgentChat } from "@/hooks/useAgentChat";
import { STAFF_CHAT_STORAGE_KEY } from "@/hooks/useChatStorage";
import { STAFF_CHAT_ENDPOINT } from "@/lib/config";

const STAFF_SUGGESTIONS = [
  "Create a new order",
  "What's open Thursday?",
  "Front brake job labor time on 2020 Camry?",
  "Show in-progress orders",
];

function WelcomeScreen({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4"
      >
        <Wrench className="w-8 h-8 text-primary" />
      </motion.div>
      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-xl font-display font-bold text-foreground mb-2"
      >
        What do you need?
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="text-muted-foreground max-w-sm"
      >
        Create orders, check labor times, look up customers, manage work orders.
      </motion.p>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-6"
      >
        <Suggestions>
          {STAFF_SUGGESTIONS.map((suggestion) => (
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

export default function AdminChatPage() {
  const prefersReducedMotion = useReducedMotion();
  const { session } = useAuth();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    uiMessages,
    isLoading,
    error,
    sendMessage,
    clearMessages,
    clearError,
  } = useAgentChat({
    accessToken: session?.access_token,
    endpoint: STAFF_CHAT_ENDPOINT,
    storageKey: STAFF_CHAT_STORAGE_KEY,
    inputRef,
  });

  // Focus input on mount only (avoid autoFocus on every state change for mobile).
  useEffect(() => {
    const isMobile = window.matchMedia("(pointer: coarse)").matches;
    if (!isMobile) {
      inputRef.current?.focus();
    }
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput("");
  };

  const renderable = useMemo(
    () =>
      uiMessages.filter((msg) => {
        if (msg.role !== "user" && msg.role !== "assistant") return false;
        return msg.parts.some(
          (p) =>
            (p.type === "text" && p.text.trim().length > 0) ||
            p.type === "reasoning" ||
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

  return (
    <main className="flex flex-col flex-1 bg-background text-foreground">
      <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full pt-8 pb-4 px-4 min-h-0">
        {/* Header */}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            prefersReducedMotion ? { duration: 0 } : { duration: 0.4 }
          }
          className="flex items-center justify-between mb-4 px-1"
        >
          <div className="flex items-center gap-3">
            <motion.div
              initial={prefersReducedMotion ? false : { scale: 0 }}
              animate={{ scale: 1 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { delay: 0.2, type: "spring", stiffness: 200 }
              }
              className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center"
            >
              <Wrench className="w-6 h-6 text-primary" />
            </motion.div>
            <div>
              <h1 className="text-xl font-display font-bold text-foreground">
                Shop Assistant
              </h1>
              <p className="text-sm text-muted-foreground">
                Orders · Labor times · Customers
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
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
          >
            Clear
          </Button>
        </motion.div>

        {/* Messages */}
        <Conversation className="flex-1 rounded-2xl border border-border bg-card min-h-0">
          <ConversationContent className="p-6">
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
                  mode="staff"
                />
              );
            })}

            {/* Submitted-state indicator: bridges the gap between user
                send and first assistant token / tool call. */}
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
              <div className="rounded-2xl bg-destructive/10 border border-destructive/20 px-5 py-3">
                <p className="text-xs font-medium text-destructive mb-1">
                  Error
                </p>
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  variant="link"
                  size="xs"
                  onClick={clearError}
                  className="text-destructive px-0 mt-1"
                >
                  Dismiss
                </Button>
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {/* Input */}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : { duration: 0.4, delay: 0.2 }
          }
          className="mt-4"
        >
          <PromptInput onSubmit={handleSubmit}>
            <label htmlFor="staff-chat-input" className="sr-only">
              Message
            </label>
            <PromptInputTextarea
              ref={inputRef}
              id="staff-chat-input"
              name="message"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onSubmitOnEnter={() => {
                if (!input.trim() || isLoading) return;
                sendMessage(input.trim());
                setInput("");
              }}
              placeholder="Create an order, check labor times..."
            />
            <PromptInputToolbar>
              <span className="pl-2 text-[11px] text-muted-foreground/60">
                Enter to send · Shift+Enter for newline
              </span>
              <PromptInputSubmit disabled={isLoading || !input.trim()} />
            </PromptInputToolbar>
          </PromptInput>
        </motion.div>
      </div>
    </main>
  );
}
