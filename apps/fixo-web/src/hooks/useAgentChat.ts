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
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AGENT_URL } from "@/lib/config";
import {
  clearStoredSessionId,
  createSessionEager,
  loadStoredSessionId,
  persistSessionId,
} from "@/lib/session";

export interface FixoEstimateData {
  success: true;
  estimateId?: number;
  vehicle: string;
  shareToken?: string;
  items: Array<{
    name: string;
    description: string;
    unitPrice: number;
    quantity: number;
    category: string;
  }>;
  subtotal: number;
  priceRange: string;
  expiresAt?: string;
  note?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageUrl?: string;
}

interface UseAgentChatOptions {
  scrollRef?: RefObject<HTMLElement | null>;
  inputRef?: RefObject<HTMLInputElement | null>;
  accessToken?: string | null;
  /** Source of truth for the current Fixo session id. The transport reads
   * this on every request so the gateway can hydrate uploaded media as
   * FileUIParts on the latest turn. The hook also writes to it during
   * restore-from-localStorage and clear flows, so it must be mutable. */
  sessionIdRef?: MutableRefObject<number | null>;
  /** Authenticated user id, used to scope persisted session/transcript so a
   * sign-out/sign-in on the same browser doesn't leak across accounts. */
  userId?: string | null;
  /** Pre-resolved transcript from the server (cross-device resume). When
   * defined — even as `[]` — it overrides the localStorage fallback. Pass
   * `undefined` to keep the legacy local-only behavior. */
  initialMessages?: UIMessage[];
  /** Pre-resolved session id (e.g. from `?session=` URL param or server
   * lookup). When defined — even as `null` — overrides the localStorage
   * fallback so the parent stays the single source of truth. */
  initialSessionId?: number | null;
}

/** Extract concatenated text from a UIMessage's parts. */
function getTextContent(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Extract all tool parts (static and dynamic) from a UIMessage. */
function getToolParts(msg: UIMessage) {
  return msg.parts.filter(isToolOrDynamicToolUIPart);
}

const STORAGE_KEY_PREFIX = "fixo-chat-history";

// Scope chat-history storage by userId so account switches on the same
// browser don't show user A's transcript to user B. Anonymous fallback is
// for the (brief) window before auth resolves; collisions with real users
// are impossible since real ids never equal "anon".
function chatHistoryKey(userId: string | null | undefined): string {
  return userId
    ? `${STORAGE_KEY_PREFIX}:${userId}`
    : `${STORAGE_KEY_PREFIX}:anon`;
}

function loadStoredMessages(
  userId: string | null | undefined,
): UIMessage[] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = localStorage.getItem(chatHistoryKey(userId));
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* ignore corrupt data */
  }
  return undefined;
}

export function useAgentChat(options: UseAgentChatOptions = {}) {
  const {
    scrollRef,
    inputRef,
    accessToken,
    sessionIdRef,
    userId,
    initialMessages: providedInitialMessages,
    initialSessionId: providedInitialSessionId,
  } = options;
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [pendingEstimate, setPendingEstimate] =
    useState<FixoEstimateData | null>(null);
  const imageUrlMapRef = useRef<Map<string, string>>(new Map());

  // Resolve the boot transcript: caller-supplied (server-resolved, supports
  // cross-device resume) wins; otherwise fall back to localStorage so a
  // single-device user with no signal from the parent still sees their
  // history after a refresh.
  const [initialMessages] = useState(() =>
    providedInitialMessages !== undefined
      ? providedInitialMessages
      : loadStoredMessages(userId),
  );

  // Re-pair the restored transcript with its backend session id so /complete
  // and /report hit the right fixoMedia rows. Ref-only — the chat page reads
  // it directly when it builds the Report URL; the transport reads it on
  // every send for hydration. No reactive state needed because the Report
  // button no longer gates on sessionId presence.
  //
  // Caller may pass `initialSessionId` (URL param / server lookup) to
  // override the localStorage path entirely. Otherwise: only restore the
  // session id when chat history was ALSO restored. If the history key is
  // missing or corrupt, the surviving session-id key is orphaned: a fresh
  // chat would otherwise inherit the previous session's photos and OBD
  // codes server-side, leaking evidence into a brand-new report. Clear
  // orphaned ids on the spot.
  const sessionRestoredRef = useRef(false);
  if (!sessionRestoredRef.current) {
    sessionRestoredRef.current = true;
    if (sessionIdRef && !sessionIdRef.current) {
      if (providedInitialSessionId !== undefined) {
        sessionIdRef.current = providedInitialSessionId;
      } else if (initialMessages && initialMessages.length > 0) {
        const restored = loadStoredSessionId(userId);
        if (restored !== null) sessionIdRef.current = restored;
      } else {
        clearStoredSessionId(userId);
      }
    }
  }
  // Tracks imageUrls by message index for new messages whose IDs aren't
  // known until after AI SDK v6 assigns them internally.
  const pendingImageUrlRef = useRef<{ index: number; url: string } | null>(
    null,
  );

  const scrollToBottom = useCallback(() => {
    scrollRef?.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollRef]);

  const focusInput = useCallback(() => {
    inputRef?.current?.focus();
  }, [inputRef]);

  // Keep headers ref in sync so transport always has fresh token
  const headersRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const h: Record<string, string> = {};
    if (accessToken) {
      h.Authorization = `Bearer ${accessToken}`;
    }
    headersRef.current = h;
  }, [accessToken]);

  // Create transport once, using ref-based resolvers so headers and the
  // current sessionId stay live without recreating the transport.
  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);
  const sessionIdRefForTransport = sessionIdRef;
  if (!transportRef.current) {
    transportRef.current = new DefaultChatTransport<UIMessage>({
      api: `${AGENT_URL}/task`,
      headers: () => headersRef.current,
      body: () => {
        const sid = sessionIdRefForTransport?.current ?? null;
        return sid !== null ? { sessionId: sid } : {};
      },
    });
  }

  const {
    messages: chatMessages,
    status,
    error: chatError,
    sendMessage: chatSendMessage,
    setMessages: setChatMessages,
    clearError: chatClearError,
  } = useChat({
    messages: initialMessages,
    transport: transportRef.current,
    // Default `lastAssistantMessageIsCompleteWithToolCalls` would loop here:
    // ask_user_question's execute() returns synchronously ("question_presented")
    // so the tool call ships back to the client already "complete." The
    // server then `stopWhen: hasToolCall("ask_user_question")` halts the
    // stream, but the helper still sees a finished tool call on the last
    // assistant turn → auto-resubmits → agent has no new input, emits 0
    // tokens, finishReason=stop, last assistant message unchanged → fires
    // again. The loop only breaks when the user actually replies. Skip
    // auto-continuation when the latest tool call is one that explicitly
    // hands control back to the user.
    sendAutomaticallyWhen: ({ messages }) => {
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) {
        return false;
      }
      const last = messages[messages.length - 1];
      if (last?.role !== "assistant") return false;
      for (const part of last.parts) {
        if (
          isToolOrDynamicToolUIPart(part) &&
          getToolOrDynamicToolName(part) === "ask_user_question"
        ) {
          return false;
        }
      }
      return true;
    },
    onFinish: () => {
      setCurrentTool(null);
      focusInput();
    },
    onError: (err) => {
      console.error("[agent] Chat error:", err);
      setCurrentTool(null);
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Persist messages to localStorage, scoped to this user so account switches
  // on the same browser don't show one user the other user's transcript.
  useEffect(() => {
    try {
      const key = chatHistoryKey(userId);
      if (chatMessages.length > 0) {
        localStorage.setItem(key, JSON.stringify(chatMessages));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      /* localStorage full or unavailable */
    }
  }, [chatMessages, userId]);

  // Track active tool calls and detect create_fixo_estimate output
  useEffect(() => {
    let latestEstimate: FixoEstimateData | null = null;

    for (const msg of chatMessages) {
      if (msg.role !== "assistant") continue;
      for (const part of getToolParts(msg)) {
        const toolName = getToolOrDynamicToolName(part);
        if (
          part.state === "input-available" ||
          part.state === "input-streaming"
        ) {
          setCurrentTool(toolName);
        } else if (part.state === "output-available") {
          setCurrentTool(null);
          if (
            toolName === "create_fixo_estimate" &&
            (part.output as Record<string, unknown>)?.success === true
          ) {
            latestEstimate = part.output as FixoEstimateData;
          }
        }
      }
    }

    setPendingEstimate(latestEstimate);
  }, [chatMessages]);

  // Scroll on new messages
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollToBottom is stable, chatMessages triggers the scroll
  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, scrollToBottom]);

  // Map to our Message interface
  const messages: Message[] = useMemo(() => {
    // Resolve any pending imageUrl (stored by raw chatMessages position) into
    // the id-keyed map. We index against the unfiltered array because the AI
    // SDK assigns its own ids and the new user message lands at the position
    // captured in sendMessage. Indexing against the text-filtered list dropped
    // the new message any time a prior assistant turn was tool-only (no text)
    // — the index would point past the end of the filtered array and the
    // preview would silently never attach.
    if (pendingImageUrlRef.current !== null) {
      const { index, url } = pendingImageUrlRef.current;
      const newMsg = chatMessages[index];
      if (newMsg && newMsg.role === "user") {
        imageUrlMapRef.current.set(newMsg.id, url);
        pendingImageUrlRef.current = null;
      }
    }

    const filtered = chatMessages
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .filter((msg) => getTextContent(msg)); // skip empty tool-only steps

    return filtered.map((msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: getTextContent(msg),
      imageUrl: imageUrlMapRef.current.get(msg.id),
    }));
  }, [chatMessages]);

  const error = chatError?.message ?? null;

  const sendMessage = useCallback(
    async (content: string, options?: { imageUrl?: string }) => {
      if (options?.imageUrl) {
        // Track by the raw chatMessages index the new user message will
        // occupy. AI SDK v6 assigns its own ids and ignores any we pre-
        // generate, so we capture position now and resolve it to an id once
        // useChat appends the message. Indexing against the unfiltered array
        // is critical: filtered views (e.g. "messages with text content") can
        // drop tool-only assistant turns and shift the position out from
        // under us, silently losing the preview.
        pendingImageUrlRef.current = {
          index: chatMessages.length,
          url: options.imageUrl,
        };
      }

      // Eagerly create the backend session on the very first send of a new
      // conversation. After creation, upgrade the URL to `/chat/[id]` via
      // the native History API — using `router.push` would unmount the chat
      // tree and abort the in-flight stream we're about to kick off below.
      // Subsequent sends short-circuit because `sessionIdRef.current` is set.
      if (sessionIdRef && !sessionIdRef.current && accessToken) {
        try {
          const newId = await createSessionEager(accessToken);
          sessionIdRef.current = newId;
          // Persist immediately so a hard refresh between this eager-create
          // and onFinish doesn't orphan the session.
          persistSessionId(newId, userId);
          if (typeof window !== "undefined") {
            window.history.replaceState(null, "", `/chat/${newId}`);
          }
        } catch (err) {
          console.error("[agent] session create failed", err);
          // Continue without a session id; the gateway will reject the /task
          // call when sessionId becomes required, and the user can retry.
        }
      }

      chatSendMessage({ text: content });
    },
    [chatSendMessage, chatMessages, accessToken, sessionIdRef, userId],
  );

  const clearMessages = useCallback(() => {
    setChatMessages([]);
    imageUrlMapRef.current.clear();
    if (sessionIdRef) sessionIdRef.current = null;
    try {
      localStorage.removeItem(chatHistoryKey(userId));
    } catch {
      /* ignore */
    }
    clearStoredSessionId(userId);
  }, [setChatMessages, sessionIdRef, userId]);

  const clearError = useCallback(() => {
    chatClearError();
  }, [chatClearError]);

  // Expose a stable lookup from UIMessage id → preview image URL. The chat
  // page renders UIMessages directly (parts-based) with AI Elements, so it
  // reads imageUrl out-of-band rather than from the simplified `messages`
  // array. The ref is mutated by the `messages` useMemo above as a side
  // effect — that's intentional: keeping the population there preserves the
  // index→id resolution that handles the AI-SDK-assigns-own-ids case.
  const getImageUrl = useCallback(
    (messageId: string): string | undefined =>
      imageUrlMapRef.current.get(messageId),
    [],
  );

  return {
    messages,
    uiMessages: chatMessages,
    isLoading,
    // Expose the raw useChat status so the UI can distinguish "submitted but
    // no token yet" (thinking indicator) from "streaming" (let Streamdown's
    // caret + tool cards take over). Vercel AI SDK pattern: show the spinner
    // ONLY on `submitted` — once `streaming` starts, content is in flight and
    // a separate indicator is redundant.
    status,
    error,
    currentTool,
    pendingEstimate,
    sendMessage,
    clearMessages,
    clearError,
    getImageUrl,
  };
}
