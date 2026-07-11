"use client";

import {
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  type UIMessage,
} from "ai";
import { Wrench } from "lucide-react";
import { memo } from "react";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { renderToolCard } from "./tool-cards";

/** Filter to messages worth rendering (non-empty text, reasoning, or tool
 * parts). Same rule the full-page chats apply inline. */
export function renderableMessages(msgs: UIMessage[]): UIMessage[] {
  return msgs.filter((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    return msg.parts.some(
      (p) =>
        (p.type === "text" && p.text.trim().length > 0) ||
        p.type === "reasoning" ||
        isToolOrDynamicToolUIPart(p),
    );
  });
}

/** Map each assistant message id to the text of the first user message that
 * follows it — drives ask_user_question / SlotPicker `isAnswered` state. */
export function mapNextUserAnswers(msgs: UIMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  let pendingAssistantIds: string[] = [];
  for (const msg of msgs) {
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
}

export interface ChatMessageProps {
  msg: UIMessage;
  /** True iff this is the LAST assistant message and chat is currently
   * streaming. Drives the Reasoning panel's "thinking" state. */
  isStreaming: boolean;
  /** Text of the next user message after this assistant turn, if any.
   * Drives ask_user_question / SlotPicker `isAnswered` state. */
  nextUserAnswer?: string;
  onAnswer: (label: string) => void;
  mode: "customer" | "staff";
  /** Skip reasoning parts entirely — customer chat hides chain-of-thought. */
  hideReasoning?: boolean;
  /** Skip the generic AI Elements <Tool> fallback for tools without a
   * custom card — customer chat does this since raw tool I/O leaks
   * pre-markup costs. */
  hideGenericToolFallback?: boolean;
}

/** Memoized per-message renderer. Streaming bursts touch the latest
 * assistant message ~100 times/second; without React.memo every prior
 * message in the conversation re-runs its full part-map JSX on every
 * token. memo with shallow-compare lets us skip that work — only the
 * streaming message re-renders. */
export const ChatMessage = memo(function ChatMessage({
  msg,
  isStreaming,
  nextUserAnswer,
  onAnswer,
  mode,
  hideReasoning = false,
  hideGenericToolFallback = false,
}: ChatMessageProps) {
  return (
    <Message from={msg.role}>
      {msg.role === "assistant" && (
        <MessageAvatar aria-hidden>
          <Wrench className="h-4 w-4" />
        </MessageAvatar>
      )}
      <MessageContent>
        {msg.parts.map((part, i) => {
          const partKey = `${msg.id}-${i}`;
          if (part.type === "text") {
            if (msg.role === "user") {
              return (
                <p
                  key={partKey}
                  className="whitespace-pre-wrap leading-relaxed"
                >
                  {part.text}
                </p>
              );
            }
            return (
              <MessageResponse key={partKey} isAnimating={isStreaming}>
                {part.text}
              </MessageResponse>
            );
          }
          if (part.type === "reasoning") {
            if (hideReasoning) return null;
            return (
              <Reasoning isStreaming={isStreaming} key={partKey}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (isToolOrDynamicToolUIPart(part)) {
            const card = renderToolCard(part, {
              isAnswered: !!nextUserAnswer,
              answer: nextUserAnswer,
              onAnswer,
              mode,
            });
            if (card) {
              return <div key={partKey}>{card}</div>;
            }
            if (hideGenericToolFallback) return null;
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
});
