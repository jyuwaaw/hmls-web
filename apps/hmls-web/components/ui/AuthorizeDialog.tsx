"use client";

import type {
  AuthorizationChannel,
  OrderAuthorization,
} from "@hmls/shared/order/status";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Resolver = (auth: OrderAuthorization | null) => void;

interface State {
  open: boolean;
  title: string;
  description: string;
  pending: Resolver | null;
}

let setStateExternal: ((s: State) => void) | null = null;
let currentState: State = {
  open: false,
  title: "",
  description: "",
  pending: null,
};

const CHANNELS: ReadonlyArray<{ value: AuthorizationChannel; label: string }> =
  [
    { value: "call", label: "Phone call" },
    { value: "text", label: "Text message" },
    { value: "in_person", label: "In person" },
    { value: "portal", label: "Customer portal" },
  ];

/** Promise-based evidence collector for fenced transitions (any →approved,
 * including the draft→approved walk-in shortcut). Returns the channel +
 * optional note, or `null` if the
 * user cancelled. Caller must render `<AuthorizeDialog />` once (mounted in
 * root layout). Resolves `null` when the dialog isn't mounted — a fenced
 * transition without evidence would be rejected server-side anyway. */
export function askAuthorization(opts: {
  title: string;
  description?: string;
}): Promise<OrderAuthorization | null> {
  if (!setStateExternal) {
    return Promise.resolve(null);
  }
  return new Promise<OrderAuthorization | null>((resolve) => {
    currentState.pending?.(null);
    currentState = {
      open: true,
      title: opts.title,
      description: opts.description ?? "",
      pending: resolve,
    };
    setStateExternal?.(currentState);
  });
}

export function AuthorizeDialog() {
  const [state, setState] = useState<State>(currentState);
  const [channel, setChannel] = useState<AuthorizationChannel>("call");
  const [note, setNote] = useState("");

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
    if (state.open) {
      setChannel("call");
      setNote("");
    }
  }, [state.open]);

  const close = (auth: OrderAuthorization | null) => {
    state.pending?.(auth);
    currentState = { ...currentState, open: false, pending: null };
    setState(currentState);
  };

  return (
    <Dialog open={state.open} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          {state.description && (
            <DialogDescription>{state.description}</DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label htmlFor="auth-channel">Authorization channel</Label>
            <select
              id="auth-channel"
              value={channel}
              onChange={(e) =>
                setChannel(e.target.value as AuthorizationChannel)
              }
              className="w-full h-9 px-3 rounded-md border border-input bg-transparent text-sm"
            >
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="auth-note">Note (optional)</Label>
            <Textarea
              id="auth-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. spoke with owner at 10:30am"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => close({ channel, note: note.trim() || undefined })}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
