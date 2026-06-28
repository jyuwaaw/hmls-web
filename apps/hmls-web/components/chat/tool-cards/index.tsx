"use client";

import {
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  type UIMessage,
} from "ai";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { ContactIntakeCard } from "./ContactIntakeCard";
import {
  type CreateOrderOutput,
  EstimateCardInline,
} from "./EstimateCardInline";
import { CUSTOMER_LOOKUP_LABELS, LookupStatusCard } from "./LookupStatusCard";
import { SlotPickerCard, type SlotPickerOutput } from "./SlotPickerCard";

type ToolPart = Extract<
  UIMessage["parts"][number],
  { type: `tool-${string}` } | { type: "dynamic-tool" }
>;

/** Render a per-tool custom card if we know about the tool, otherwise return
 * `null` so the caller falls back to the generic AI Elements <Tool>.
 *
 * `mode` controls the floor for what's shown:
 * - `staff` (default) — every recognized tool gets a custom card; unknown
 *   tools fall through to the caller's generic <Tool> fallback.
 * - `customer` — additionally renders a one-line LookupStatusCard for
 *   whitelisted backstage lookups (lookup_parts_price, etc.) so customers
 *   see progress without ever seeing raw tool I/O. The caller should drop
 *   the generic <Tool> fallback in customer mode — raw I/O leaks
 *   pre-markup costs and internal labor hours. */
export function renderToolCard(
  part: UIMessage["parts"][number],
  opts: {
    isAnswered?: boolean;
    answer?: string;
    onAnswer?: (label: string) => void;
    mode?: "customer" | "staff";
  } = {},
): React.ReactNode {
  if (!isToolOrDynamicToolUIPart(part)) return null;
  const toolPart = part as ToolPart;
  const toolName = getToolOrDynamicToolName(toolPart);
  const state = toolPart.state;
  const mode = opts.mode ?? "staff";

  if (toolName === "load_skill") {
    // Backstage tool — never render the raw skill body (it's a ~350-line
    // markdown dump). Customer: hidden. Staff: a one-line chip.
    if (mode === "customer") return null;
    const skill = (toolPart as { input?: { name?: string } }).input?.name;
    return (
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        📚 Loaded {skill ?? "skill"} playbook
      </div>
    );
  }

  if (toolName === "ask_user_question") {
    const input = (toolPart as { input?: unknown }).input as
      | {
          question?: string;
          header?: string;
          options?: Array<{ label: string; description?: string }>;
        }
      | undefined;
    if (
      !input?.question ||
      !Array.isArray(input.options) ||
      input.options.length === 0
    ) {
      return null;
    }
    return (
      <AskUserQuestionCard
        answer={opts.answer}
        input={{
          question: input.question,
          header: input.header ?? "",
          options: input.options,
        }}
        isAnswered={opts.isAnswered ?? false}
        onAnswer={(label) => opts.onAnswer?.(label)}
      />
    );
  }

  if (toolName === "collect_contact") {
    const input = (toolPart as { input?: unknown }).input as
      | { note?: string }
      | undefined;
    return (
      <ContactIntakeCard
        note={input?.note}
        isAnswered={opts.isAnswered ?? false}
        answer={opts.answer}
        onSubmit={(message) => opts.onAnswer?.(message)}
      />
    );
  }

  if (toolName === "get_availability" && state === "output-available") {
    const output = (toolPart as { output?: unknown }).output as
      | SlotPickerOutput
      | undefined;
    if (!output || !Array.isArray(output.slots)) return null;
    return (
      <SlotPickerCard
        output={output}
        isAnswered={opts.isAnswered ?? false}
        onSelect={(message) => opts.onAnswer?.(message)}
      />
    );
  }

  if (toolName === "create_order" && state === "output-available") {
    const output = (toolPart as { output?: unknown }).output as
      | CreateOrderOutput
      | undefined;
    if (!output?.success) return null;
    return <EstimateCardInline output={output} mode={mode} />;
  }

  // Customer mode: render a friendly status pill for whitelisted backstage
  // lookups so progress is visible without leaking raw tool I/O.
  if (mode === "customer" && CUSTOMER_LOOKUP_LABELS[toolName]) {
    return <LookupStatusCard toolName={toolName} state={state} />;
  }

  return null;
}

export {
  AskUserQuestionCard,
  ContactIntakeCard,
  type CreateOrderOutput,
  EstimateCardInline,
  LookupStatusCard,
  SlotPickerCard,
  type SlotPickerOutput,
};
