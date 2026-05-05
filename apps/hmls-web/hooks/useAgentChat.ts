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

  // Recreate the transport when the endpoint changes; a single hook
  // instance might be repointed at a different surface (customer ↔ staff)
  // by the consumer. Headers stay fresh via headersRef without recreation.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: endpoint,
        headers: () => headersRef.current,
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
