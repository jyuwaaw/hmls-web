"use client";

import { ArrowUpIcon } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PromptInputProps = ComponentProps<"form">;

/** Container for the prompt input. Renders as a `<form>` with a card-like
 *  surround so the textarea + toolbar feel like one unit. Submit is wired
 *  to the standard form `onSubmit` — caller controls what to do. */
export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <form
    className={cn(
      "flex w-full flex-col rounded-2xl border border-border bg-surface shadow-sm transition-colors",
      "focus-within:border-red-primary/50 focus-within:ring-2 focus-within:ring-red-primary/15",
      className,
    )}
    {...props}
  />
);

export type PromptInputTextareaProps =
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    /** Submit the parent form on Enter (Shift+Enter inserts newline). */
    onSubmitOnEnter?: () => void;
    /** Maximum auto-grown height in px before scroll kicks in. */
    maxHeight?: number;
  };

/** Auto-growing textarea. The container above handles focus styling, so
 *  this strips outline/border and just owns its own height. */
export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  PromptInputTextareaProps
>(
  (
    {
      className,
      onSubmitOnEnter,
      onKeyDown,
      onChange,
      maxHeight = 240,
      rows = 1,
      ...props
    },
    forwardedRef,
  ) => {
    const localRef = useRef<HTMLTextAreaElement | null>(null);

    useImperativeHandle(
      forwardedRef,
      () => localRef.current as HTMLTextAreaElement,
      [],
    );

    const resize = useCallback(() => {
      const el = localRef.current;
      if (!el) return;
      el.style.height = "auto";
      const next = Math.min(el.scrollHeight, maxHeight);
      el.style.height = `${next}px`;
    }, [maxHeight]);

    // Resize on every external value change (parent clearing the textarea
    // after submit, programmatic edits). Internal edits already resize via
    // the onChange handler below. `value` is the trigger but the resize
    // function reads from the DOM, so the linter doesn't see the link.
    // biome-ignore lint/correctness/useExhaustiveDependencies: value is the trigger, not the dep
    useEffect(() => {
      resize();
    }, [resize, props.value]);

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSubmitOnEnter?.();
      }
      onKeyDown?.(e);
    };

    return (
      <textarea
        ref={localRef}
        rows={rows}
        onKeyDown={handleKeyDown}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        className={cn(
          "w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground/70",
          "focus:outline-none disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
PromptInputTextarea.displayName = "PromptInputTextarea";

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>;

/** Bottom row inside the prompt card — for inline tools on the left and
 *  the submit button on the right. Empty slots collapse cleanly. */
export const PromptInputToolbar = ({
  className,
  ...props
}: PromptInputToolbarProps) => (
  <div
    className={cn(
      "flex items-center justify-between gap-2 px-2 pb-2 pt-1",
      className,
    )}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  /** When true (default), shows an arrow-up icon. Pass children to override. */
  defaultIcon?: boolean;
};

/** Submit button for the prompt. Defaults to a circular red icon button to
 *  match the site's accent. Disabled state is the caller's job. */
export const PromptInputSubmit = ({
  className,
  children,
  defaultIcon = true,
  ...props
}: PromptInputSubmitProps) => (
  <Button
    type="submit"
    size="icon-sm"
    className={cn(
      "h-8 w-8 rounded-full bg-red-primary text-white hover:bg-red-dark disabled:opacity-40",
      className,
    )}
    {...props}
  >
    {children ?? (defaultIcon ? <ArrowUpIcon className="h-4 w-4" /> : null)}
    <span className="sr-only">Send</span>
  </Button>
);

export type PromptInputBodyProps = ComponentProps<"form"> & {
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
};
