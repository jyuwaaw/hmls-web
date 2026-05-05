"use client";

import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type SuggestionsProps = HTMLAttributes<HTMLDivElement>;

/** Container for a row of suggestion pills. Wraps to multiple lines on
 *  narrow screens. */
export const Suggestions = ({ className, ...props }: SuggestionsProps) => (
  <div
    className={cn("flex flex-wrap justify-center gap-2", className)}
    {...props}
  />
);

export type SuggestionProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Body text. Passed verbatim to the click handler so the caller doesn't
   *  have to read children — this is the canonical AI Elements API. */
  suggestion: string;
  onSuggestionClick?: (suggestion: string) => void;
};

/** Single clickable pill. Uses brand-red accent on hover so the user knows
 *  these are taps, not labels. */
export const Suggestion = ({
  className,
  suggestion,
  onSuggestionClick,
  onClick,
  children,
  ...props
}: SuggestionProps) => (
  <button
    type="button"
    onClick={(e) => {
      onClick?.(e);
      if (!e.defaultPrevented) onSuggestionClick?.(suggestion);
    }}
    className={cn(
      "rounded-full border border-border bg-surface-alt px-4 py-2 text-sm text-text-secondary",
      "transition-all hover:border-red-primary/50 hover:text-red-primary hover:scale-[1.02] active:scale-100",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-primary/50",
      className,
    )}
    {...props}
  >
    {children ?? suggestion}
  </button>
);
