import { describe, expect, mock, test } from "bun:test";
import {
  invokeMechanicJobAction,
  type MechanicJobAction,
  type MechanicPaymentInput,
  mechanicJobAction,
} from "./mechanic-job-actions";

describe("mechanicJobAction — button per status", () => {
  test("approved shows Start", () => {
    expect(mechanicJobAction("approved")).toEqual({
      label: "Start",
      busyLabel: "Starting…",
      to: "in_progress",
    });
  });

  test("legacy 'scheduled' canonicalizes to approved → Start", () => {
    expect(mechanicJobAction("scheduled")?.to).toBe("in_progress");
  });

  test("in_progress shows Complete", () => {
    expect(mechanicJobAction("in_progress")).toEqual({
      label: "Complete",
      busyLabel: "Completing…",
      to: "completed",
    });
  });

  test.each([
    "draft",
    "estimated",
    "declined",
    "completed",
    "cancelled",
  ])("%s shows no button", (status) => {
    expect(mechanicJobAction(status)).toBeNull();
  });

  test("unknown status shows no button", () => {
    expect(mechanicJobAction("garbage")).toBeNull();
  });
});

describe("invokeMechanicJobAction — complete soft-prompts for diagnosis", () => {
  const start: MechanicJobAction = {
    label: "Start",
    busyLabel: "Starting…",
    to: "in_progress",
  };
  const complete: MechanicJobAction = {
    label: "Complete",
    busyLabel: "Completing…",
    to: "completed",
  };

  test("start transitions immediately, no prompt", async () => {
    const transition = mock(async () => {});
    const ask = mock(async () => "never");
    await invokeMechanicJobAction(
      start,
      { confirmedDiagnosis: null },
      transition,
      ask,
    );
    expect(ask).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith("in_progress");
  });

  test("complete without diagnosis prompts; text is passed through", async () => {
    const transition = mock(async () => {});
    const ask = mock(async () => "  bad alternator  ");
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: null },
      transition,
      ask,
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith("completed", "bad alternator");
  });

  test("blank prompt completes without a diagnosis (skippable)", async () => {
    const transition = mock(async () => {});
    const ask = mock(async () => "");
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: null },
      transition,
      ask,
    );
    expect(transition).toHaveBeenCalledWith("completed", undefined);
  });

  test("cancelling the prompt backs out of completing", async () => {
    const transition = mock(async () => {});
    const ask = mock(async () => null);
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: null },
      transition,
      ask,
    );
    expect(transition).not.toHaveBeenCalled();
  });

  test("existing diagnosis skips the prompt", async () => {
    const transition = mock(async () => {});
    const ask = mock(async () => "never");
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "already recorded" },
      transition,
      ask,
    );
    expect(ask).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith("completed");
  });
});

describe("invokeMechanicJobAction — optional payment step after Complete", () => {
  const complete: MechanicJobAction = {
    label: "Complete",
    busyLabel: "Completing…",
    to: "completed",
  };
  const payment: MechanicPaymentInput = {
    amountCents: 25000,
    method: "cash",
    reference: "receipt-1",
  };
  const noReason = mock(async () => "");

  test("start never offers payment", async () => {
    const transition = mock(async () => {});
    const askPayment = mock(async () => payment);
    const record = mock(async (_p: MechanicPaymentInput) => {});
    await invokeMechanicJobAction(
      { label: "Start", busyLabel: "Starting…", to: "in_progress" },
      { confirmedDiagnosis: null },
      transition,
      noReason,
      { ask: askPayment, record },
    );
    expect(askPayment).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  test("complete offers payment; entered fields are recorded", async () => {
    const transition = mock(async () => {});
    const askPayment = mock(async () => payment);
    const record = mock(async (_p: MechanicPaymentInput) => {});
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "done" },
      transition,
      noReason,
      { ask: askPayment, record },
    );
    expect(transition).toHaveBeenCalledWith("completed");
    expect(askPayment).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(payment);
  });

  test("skip path: no payment call, complete stands", async () => {
    const transition = mock(async () => {});
    const askPayment = mock(async () => null);
    const record = mock(async (_p: MechanicPaymentInput) => {});
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "done" },
      transition,
      noReason,
      { ask: askPayment, record },
    );
    expect(transition).toHaveBeenCalledWith("completed");
    expect(record).not.toHaveBeenCalled();
  });

  test("backing out of the diagnosis prompt never reaches payment", async () => {
    const transition = mock(async () => {});
    const askPayment = mock(async () => payment);
    const record = mock(async (_p: MechanicPaymentInput) => {});
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: null },
      transition,
      mock(async () => null), // cancel the diagnosis prompt
      { ask: askPayment, record },
    );
    expect(transition).not.toHaveBeenCalled();
    expect(askPayment).not.toHaveBeenCalled();
  });

  test("payment failure never throws: retry affordance, complete stands", async () => {
    const transition = mock(async () => {});
    const record = mock(async (_p: MechanicPaymentInput) => {
      throw new Error("network down");
    });
    // First ask enters a payment; the retry re-ask (with the error) skips.
    const asks: Array<{ error?: string }> = [];
    const askPayment = mock(async (opts: { error?: string }) => {
      asks.push(opts);
      return asks.length === 1 ? payment : null;
    });

    // Must resolve (not reject) — complete is the primary op.
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "done" },
      transition,
      noReason,
      { ask: askPayment, record },
    );
    expect(transition).toHaveBeenCalledTimes(1); // complete not rolled back
    expect(asks[0].error).toBeUndefined();
    expect(asks[1].error).toBe("network down"); // retry carries the error
  });

  test("retry after failure records on second attempt", async () => {
    const transition = mock(async () => {});
    let calls = 0;
    const record = mock(async (_p: MechanicPaymentInput) => {
      calls += 1;
      if (calls === 1) throw new Error("flaky");
    });
    const askPayment = mock(async () => payment);
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "done" },
      transition,
      noReason,
      { ask: askPayment, record },
    );
    expect(record).toHaveBeenCalledTimes(2);
    expect(askPayment).toHaveBeenCalledTimes(2);
  });

  test("no payment step provided: complete works as before", async () => {
    const transition = mock(async () => {});
    await invokeMechanicJobAction(
      complete,
      { confirmedDiagnosis: "done" },
      transition,
      noReason,
    );
    expect(transition).toHaveBeenCalledWith("completed");
  });
});
