"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  /** Optional inline label rendered to the right of the dots. */
  label?: string;
};

/** Three-dot bouncing loader. Used for the "assistant is working" indicator
 *  while waiting for the first token of a streamed response or for a tool
 *  result to come back. Tied to the brand red accent so it reads as ours. */
export const Loader = ({ className, label, ...props }: LoaderProps) => (
  <div
    aria-label={label ?? "Working"}
    role="status"
    className={cn(
      "inline-flex items-center gap-2 rounded-full border border-border bg-surface-alt px-3 py-1 text-xs text-text-secondary",
      className,
    )}
    {...props}
  >
    <span className="flex items-center gap-1">
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-red-primary [animation-delay:-0.3s]"
        aria-hidden
      />
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-red-primary [animation-delay:-0.15s]"
        aria-hidden
      />
      <span
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-red-primary"
        aria-hidden
      />
    </span>
    {label && <span>{label}</span>}
  </div>
);
