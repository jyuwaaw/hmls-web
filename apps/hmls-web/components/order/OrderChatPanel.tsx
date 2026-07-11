"use client";

import { ChevronDown, Wrench } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
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
import {
  ChatMessage,
  mapNextUserAnswers,
  renderableMessages,
} from "@/components/chat/ChatMessage";
import { Button } from "@/components/ui/button";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentChat } from "@/hooks/useAgentChat";
import { readActiveShop } from "@/lib/active-shop";
import { STAFF_CHAT_ENDPOINT } from "@/lib/config";
import { orderChatBody, orderChatStorageKey } from "@/lib/order-chat";
import { cn } from "@/lib/utils";

const ORDER_SUGGESTIONS = [
  "Assign a mechanic",
  "Send the estimate to the customer",
  "Record a payment",
  "What's the next step for this order?",
];

type Props = {
  orderId: string | number;
  /** SWR mutate for the order detail — called after each agent turn so
   * tool mutations (assign/transition/payment/items) show up on the page. */
  revalidate(): void;
};

/** Embedded staff chat scoped to one order (PR 6). Collapsible card; the
 * chat body mounts on first expand and stays mounted afterwards (hidden via
 * CSS) so collapsing never aborts an in-flight tool call. */
export function OrderChatPanel({ orderId, revalidate }: Props) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
            setEverOpened(true);
          }}
        >
          <CardTitle className="text-sm flex items-center gap-2">
            <Wrench className="w-4 h-4 text-primary" />
            Shop Assistant
            <span className="font-normal text-muted-foreground">
              · Order #{orderId}
            </span>
          </CardTitle>
          <ChevronDown
            className={cn(
              "w-4 h-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </CardHeader>
      {everOpened && (
        <CardContent className={cn("px-4 pb-4", !open && "hidden")}>
          <OrderChatBody orderId={orderId} revalidate={revalidate} />
        </CardContent>
      )}
    </Card>
  );
}

function OrderChatBody({ orderId, revalidate }: Props) {
  const { session } = useAuth();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Storage key is per shop + order (design C5) so order A's transcript never
  // seeds order B. Computed once — only mounted client-side, post-interaction.
  const [storageKey] = useState(() =>
    orderChatStorageKey(readActiveShop(window.localStorage), orderId),
  );
  const body = useMemo(() => orderChatBody(orderId), [orderId]);

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
    storageKey,
    inputRef,
    body,
    onFinish: revalidate,
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput("");
  };

  const renderable = useMemo(
    () => renderableMessages(uiMessages),
    [uiMessages],
  );
  const nextUserAnswerByAssistantId = useMemo(
    () => mapNextUserAnswers(renderable),
    [renderable],
  );

  return (
    <div className="flex flex-col gap-3">
      <Conversation className="h-96 rounded-xl border border-border bg-background">
        <ConversationContent className="p-4">
          {renderable.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4">
              <p className="text-sm text-muted-foreground max-w-xs">
                Ask about this order — assign a mechanic, edit items, send the
                estimate, record a payment.
              </p>
              <Suggestions>
                {ORDER_SUGGESTIONS.map((s) => (
                  <Suggestion
                    key={s}
                    suggestion={s}
                    onSuggestionClick={sendMessage}
                  />
                ))}
              </Suggestions>
            </div>
          )}
          {renderable.map((msg, idx) => {
            const isLastAssistant =
              idx === renderable.length - 1 && msg.role === "assistant";
            return (
              <ChatMessage
                key={msg.id}
                msg={msg}
                isStreaming={isLastAssistant && isLoading}
                nextUserAnswer={
                  msg.role === "assistant"
                    ? nextUserAnswerByAssistantId.get(msg.id)
                    : undefined
                }
                onAnswer={sendMessage}
                mode="staff"
              />
            );
          })}
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
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-4 py-3">
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

      <PromptInput onSubmit={handleSubmit}>
        <label htmlFor={`order-chat-input-${orderId}`} className="sr-only">
          Message about order #{orderId}
        </label>
        <PromptInputTextarea
          ref={inputRef}
          id={`order-chat-input-${orderId}`}
          name="message"
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSubmitOnEnter={() => {
            if (!input.trim() || isLoading) return;
            sendMessage(input.trim());
            setInput("");
          }}
          placeholder={`Ask about order #${orderId}…`}
        />
        <PromptInputToolbar>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            className="text-muted-foreground"
            onClick={async () => {
              if (
                uiMessages.length === 0 ||
                (await askConfirm({
                  title: "Clear chat history?",
                  description:
                    "This removes this order's chat from this device.",
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
          <PromptInputSubmit disabled={isLoading || !input.trim()} />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  );
}
