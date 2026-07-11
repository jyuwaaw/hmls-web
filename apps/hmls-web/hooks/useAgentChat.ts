"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearStoredChat,
  DEFAULT_CHAT_STORAGE_KEY,
  loadStoredChatMessages,
  useChatPersist,
} from "@/hooks/useChatStorage";
import { readActiveShop } from "@/lib/active-shop";
import { CHAT_ENDPOINT } from "@/lib/config";

interface UseAgentChatOptions {
  /** Optional ref to a focusable input/textarea. Hook only calls `.focus()`,
   *  so any element with that method works. Customer chat uses a textarea
   *  (PromptInput), admin chat still uses a plain input. */
  inputRef?: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  accessToken?: string | null;
  endpoint?: string;
  /** localStorage key for chat history. Use distinct keys per chat surface
   * (e.g. customer vs. staff) so conversations don't cross-contaminate. */
  storageKey?: string;
  /** Extra fields merged into EVERY send request body (top level, alongside
   * `messages`). The embedded order chat uses this to carry `orderId`. */
  body?: Record<string, unknown>;
  /** Called after each assistant response finishes streaming. The embedded
   * order chat uses this to revalidate the order data the agent may have
   * mutated via tools. */
  onFinish?: () => void;
}

/** Auto-send when the last assistant message completed a tool call, EXCEPT
 * when that tool was `ask_user_question` — those are answered by the user
 * tapping an option, not by an automatic round-trip to the model. */
function sendAutomaticallyWhenNotAskUser({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  const hasAskUserQuestion = last.parts
    .filter(isToolOrDynamicToolUIPart)
    .some(
      (p) =>
        p.state === "output-available" &&
        getToolOrDynamicToolName(p) === "ask_user_question",
    );
  return !hasAskUserQuestion;
}

export function useAgentChat(options: UseAgentChatOptions = {}) {
  const {
    inputRef,
    accessToken,
    endpoint = CHAT_ENDPOINT,
    storageKey = DEFAULT_CHAT_STORAGE_KEY,
    body,
    onFinish,
  } = options;

  const [initialMessages] = useState(() => loadStoredChatMessages(storageKey));

  const focusInput = useCallback(() => {
    inputRef?.current?.focus();
  }, [inputRef]);

  // Keep headers ref in sync so the transport always has a fresh token.
  const headersRef = useRef<Record<string, string>>({});
  useEffect(() => {
    headersRef.current = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : {};
  }, [accessToken]);

  // Same ref pattern for the extra body and onFinish — callers can pass
  // inline objects/closures without recreating the transport or the chat.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  // Recreate the transport when the endpoint changes; a single hook
  // instance might be repointed at a different surface (customer ↔ staff)
  // by the consumer. Headers stay fresh via headersRef without recreation.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: endpoint,
        headers: () => {
          // Read the active shop fresh per send so an owner switching shops
          // mid-chat is honored (matches api-client.ts CRUD scoping). Customer
          // chat never sets an active shop → no header, resolved server-side.
          const h = { ...headersRef.current };
          const shopId =
            typeof window === "undefined"
              ? null
              : readActiveShop(window.localStorage);
          if (shopId) h["X-Shop-Id"] = shopId;
          return h;
        },
        body: () => bodyRef.current ?? {},
      }),
    [endpoint],
  );

  const {
    messages: uiMessages,
    status,
    error: chatError,
    sendMessage: chatSendMessage,
    setMessages: setChatMessages,
    clearError: chatClearError,
  } = useChat({
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: sendAutomaticallyWhenNotAskUser,
    onFinish: () => {
      focusInput();
      onFinishRef.current?.();
    },
    onError: (err) => {
      console.error("[agent] Chat error:", err);
    },
  });

  useChatPersist(uiMessages, storageKey);

  const isLoading = status === "submitted" || status === "streaming";
  const error = chatError?.message ?? null;

  const sendMessage = useCallback(
    (content: string) => {
      chatSendMessage({ text: content });
    },
    [chatSendMessage],
  );

  const clearMessages = useCallback(() => {
    setChatMessages([]);
    clearStoredChat(storageKey);
  }, [setChatMessages, storageKey]);

  return {
    uiMessages,
    isLoading,
    error,
    sendMessage,
    clearMessages,
    clearError: chatClearError,
  };
}
