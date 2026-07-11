"use client";

// Promise-based payment capture for the mechanic complete flow — same global
// idiom as ReasonDialog (mounted once, driven via askPayment). Skippable by
// design: completing the job already succeeded, payment is a bonus write.

import { PAYMENT_METHODS } from "@hmls/shared/order/status";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MechanicPaymentInput } from "@/lib/mechanic-job-actions";

type Resolver = (result: MechanicPaymentInput | null) => void;

interface State {
  open: boolean;
  defaultAmountCents: number;
  /** Set when re-opened after a failed payment write (retry). */
  error: string;
  pending: Resolver | null;
}

let setStateExternal: ((s: State) => void) | null = null;
let currentState: State = {
  open: false,
  defaultAmountCents: 0,
  error: "",
  pending: null,
};

/** Open the payment dialog. Resolves the entered payment, or `null` if the
 *  mechanic skipped. Caller must render `<CollectPaymentDialog />` once. If
 *  the dialog isn't mounted (SSR / tests) it resolves null — skip. */
export function askPayment(opts: {
  defaultAmountCents: number;
  error?: string;
}): Promise<MechanicPaymentInput | null> {
  if (!setStateExternal) return Promise.resolve(null);
  return new Promise<MechanicPaymentInput | null>((resolve) => {
    currentState.pending?.(null);
    currentState = {
      open: true,
      defaultAmountCents: opts.defaultAmountCents,
      error: opts.error ?? "",
      pending: resolve,
    };
    setStateExternal?.(currentState);
  });
}

export function CollectPaymentDialog() {
  const [state, setState] = useState<State>(currentState);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    setStateExternal = (s) => {
      currentState = s;
      setState(s);
    };
    return () => {
      setStateExternal = null;
    };
  }, []);

  useEffect(() => {
    // Fresh open: prefill from the order subtotal. Retry re-open (error set):
    // keep whatever the mechanic already typed.
    if (state.open && !state.error) {
      setAmount((state.defaultAmountCents / 100).toFixed(2));
      setMethod("cash");
      setReference("");
      setValidation(null);
    }
  }, [state.open, state.error, state.defaultAmountCents]);

  const close = (result: MechanicPaymentInput | null) => {
    state.pending?.(result);
    currentState = { ...currentState, open: false, pending: null };
    setState(currentState);
  };

  const submit = () => {
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setValidation("Enter a positive amount");
      return;
    }
    setValidation(null);
    close({
      amountCents: cents,
      method,
      reference: reference.trim() || undefined,
    });
  };

  return (
    <Dialog open={state.open} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Collect payment</DialogTitle>
          <DialogDescription>
            Job completed. Record the payment now, or skip — the office can mark
            it paid later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label htmlFor="cp-amount">Amount (USD)</Label>
            <Input
              id="cp-amount"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cp-method">Method</Label>
            <select
              id="cp-method"
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
            <Label htmlFor="cp-reference">Reference (optional)</Label>
            <Input
              id="cp-reference"
              placeholder="check #, confirmation code, etc."
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {(validation || state.error) && (
            <p className="text-xs text-destructive">
              {validation ?? `${state.error} — try again or skip.`}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(null)}>
            Skip
          </Button>
          <Button onClick={submit}>Record payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
