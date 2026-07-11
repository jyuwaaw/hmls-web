"use client";

import type { Order } from "@hmls/shared/db/types";
import { Button } from "@/components/ui/button";
import type { ActionDescriptor } from "@/lib/order-actions";
import { cn } from "@/lib/utils";

type Props = {
  action: ActionDescriptor;
  order: Order;
  onClick(action: ActionDescriptor): void;
  /** Render large/featured (banner button or panel primary slot). */
  prominent?: boolean;
  /** Banner styling — amber background for the draft-review banner. */
  banner?: boolean;
  disabled?: boolean;
};

export function ActionButton({
  action,
  order,
  onClick,
  prominent,
  banner,
  disabled,
}: Props) {
  const variant = action.variant(order);
  const label = action.label(order);
  const actionEnabled = action.enabled(order);
  const isEnabled = actionEnabled && !disabled;
  // Disabled buttons swallow pointer events, so the hint rides on a wrapper.
  const hint = !actionEnabled ? action.disabledHint?.(order) : undefined;

  return (
    <span title={hint} className="w-full">
      <Button
        variant={
          variant === "danger" ? "outline" : prominent ? "default" : "ghost"
        }
        size={prominent ? "sm" : "xs"}
        disabled={!isEnabled}
        onClick={() => onClick(action)}
        className={cn(
          "w-full justify-center",
          variant === "danger" &&
            "text-destructive border-destructive/30 hover:bg-destructive/10",
          banner && "bg-amber-600 hover:bg-amber-700 text-white",
        )}
      >
        {label}
      </Button>
      {hint && (
        <span className="mt-1 block text-center text-[10px] text-muted-foreground">
          {hint}
        </span>
      )}
    </span>
  );
}
