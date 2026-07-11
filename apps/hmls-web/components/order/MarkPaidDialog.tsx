"use client";

import { PAYMENT_METHODS } from "@hmls/shared/order/status";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  defaultAmountCents: number;
  saving: boolean;
  onSubmit(args: {
    amountCents: number;
    method: string;
    reference?: string;
  }): Promise<void>;
};

export function MarkPaidDialog({
  open,
  onOpenChange,
  defaultAmountCents,
  saving,
  onSubmit,
}: Props) {
  const [amount, setAmount] = useState((defaultAmountCents / 100).toFixed(2));
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter a positive amount");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        amountCents: cents,
        method,
        reference: reference.trim() || undefined,
      });
    } catch {
      // useOrderMutations.markPaid already toasts on failure; swallow here
      // so the click handler doesn't leak an unhandled rejection.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label htmlFor="mp-amount">Amount (USD)</Label>
            <Input
              id="mp-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="mp-method">Method</Label>
            <select
              id="mp-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full h-9 px-3 rounded-md border border-input bg-transparent text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="mp-reference">Reference (optional)</Label>
            <Input
              id="mp-reference"
              placeholder="check #, confirmation code, etc."
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
