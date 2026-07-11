import { describe, expect, mock, test } from "bun:test";
import type { Order } from "@hmls/shared/db/types";
import { STATUS_PROFILES } from "@hmls/shared/order/profiles";
import type { OrderStatus } from "@hmls/shared/order/status";
import {
  ACTION_REGISTRY,
  type ActionContext,
  leadAction,
} from "./order-actions";

function makeOrder(overrides: Partial<Order> = {}): Order {
  const base = {
    id: 1,
    status: "draft" as OrderStatus,
    scheduledAt: null,
    providerId: null,
    paidAt: null,
  };
  // Narrow type cast — tests only exercise the fields above. Add fields here
  // if a new ActionDescriptor reads them.
  return { ...base, ...overrides } as unknown as Order;
}

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    order: makeOrder(),
    transitionStatus: mock(async () => {}),
    setSchedule: mock(async () => {}),
    markPaid: mock(async () => {}),
    saveConfirmedDiagnosis: mock(async () => {}),
    openDialog: mock(() => {}),
    askReason: mock(async () => "reason"),
    askAuthorization: mock(async () => ({ channel: "call" as const })),
    mutate: mock(() => {}),
    ...overrides,
  };
}

describe("ACTION_REGISTRY", () => {
  test("send_to_customer is hidden on draft+tentative", () => {
    const o = makeOrder({
      status: "draft",
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    expect(ACTION_REGISTRY.send_to_customer.visible(o)).toBe(false);
  });

  test("send_to_customer is visible on plain draft", () => {
    const o = makeOrder({
      status: "draft",
      scheduledAt: null,
      providerId: null,
    });
    expect(ACTION_REGISTRY.send_to_customer.visible(o)).toBe(true);
  });

  test("approve_walk_in requires scheduledAt + providerId", () => {
    const partial = makeOrder({
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: null,
    });
    expect(ACTION_REGISTRY.approve_walk_in.visible(partial)).toBe(false);

    const full = makeOrder({
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    expect(ACTION_REGISTRY.approve_walk_in.visible(full)).toBe(true);
  });

  test("start_job is disabled (with hint) until a mechanic is assigned", () => {
    const unassigned = makeOrder({ status: "approved", providerId: null });
    expect(ACTION_REGISTRY.start_job.enabled(unassigned)).toBe(false);
    expect(ACTION_REGISTRY.start_job.disabledHint?.(unassigned)).toBe(
      "Assign a mechanic before starting",
    );

    const assigned = makeOrder({ status: "approved", providerId: 7 });
    expect(ACTION_REGISTRY.start_job.enabled(assigned)).toBe(true);
    expect(ACTION_REGISTRY.start_job.disabledHint?.(assigned)).toBeUndefined();
  });

  test("mark_paid hides once paidAt is set", () => {
    const unpaid = makeOrder({ paidAt: null });
    expect(ACTION_REGISTRY.mark_paid.visible(unpaid)).toBe(true);
    const paid = makeOrder({ paidAt: "2026-05-26T12:00:00Z" });
    expect(ACTION_REGISTRY.mark_paid.visible(paid)).toBe(false);
  });

  test("cancel_order variant flips by status", () => {
    expect(
      ACTION_REGISTRY.cancel_order.variant(makeOrder({ status: "draft" })),
    ).toBe("secondary");
    expect(
      ACTION_REGISTRY.cancel_order.variant(makeOrder({ status: "approved" })),
    ).toBe("danger");
    // Window-period legacy label: physical 'revised' canonicalizes to draft.
    expect(
      ACTION_REGISTRY.cancel_order.variant(
        makeOrder({ status: "revised" as OrderStatus }),
      ),
    ).toBe("secondary");
  });

  test("reassign_mechanic label flips by providerId", () => {
    expect(
      ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: null })),
    ).toBe("Assign mechanic");
    expect(
      ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: 7 })),
    ).toBe("Reassign mechanic");
  });

  test("set_time and reschedule split on scheduledAt — never both, no dup label", () => {
    const unscheduled = makeOrder({ scheduledAt: null });
    const scheduled = makeOrder({ scheduledAt: "2026-05-25T10:00:00Z" });

    // Unscheduled: only set_time shows, labelled "Set appointment time".
    expect(ACTION_REGISTRY.set_time.visible(unscheduled)).toBe(true);
    expect(ACTION_REGISTRY.reschedule.visible(unscheduled)).toBe(false);
    expect(ACTION_REGISTRY.set_time.label(unscheduled)).toBe(
      "Set appointment time",
    );

    // Scheduled: only reschedule shows, labelled "Reschedule".
    expect(ACTION_REGISTRY.reschedule.visible(scheduled)).toBe(true);
    expect(ACTION_REGISTRY.set_time.visible(scheduled)).toBe(false);
    expect(ACTION_REGISTRY.reschedule.label(scheduled)).toBe("Reschedule");
  });
});

describe("ACTION_REGISTRY.invoke behavior", () => {
  test("send_to_customer transitions to estimated", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.send_to_customer.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("estimated");
  });

  test("revise_estimate re-opens the declined order as a draft", async () => {
    // `revised` no longer exists — draft is the single shop-side WIP state.
    const ctx = makeCtx();
    await ACTION_REGISTRY.revise_estimate.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("draft");
  });

  test("approve_estimate collects evidence and forwards it", async () => {
    const auth = { channel: "text" as const, note: "customer texted OK" };
    const ctx = makeCtx({ askAuthorization: mock(async () => auth) });
    await ACTION_REGISTRY.approve_estimate.invoke(ctx);
    expect(ctx.askAuthorization).toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith(
      "approved",
      undefined,
      auth,
    );
  });

  test("approve_estimate aborts when the evidence dialog is cancelled", async () => {
    const ctx = makeCtx({ askAuthorization: mock(async () => null) });
    await ACTION_REGISTRY.approve_estimate.invoke(ctx);
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });

  test("approve_walk_in collects evidence and targets approved", async () => {
    // The walk-in shortcut is draft→approved now (no `scheduled` state) and
    // stays fenced: evidence is mandatory.
    const auth = { channel: "in_person" as const };
    const ctx = makeCtx({ askAuthorization: mock(async () => auth) });
    await ACTION_REGISTRY.approve_walk_in.invoke(ctx);
    expect(ctx.askAuthorization).toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith(
      "approved",
      undefined,
      auth,
    );
  });

  test("approve_walk_in aborts when the evidence dialog is cancelled", async () => {
    const ctx = makeCtx({ askAuthorization: mock(async () => null) });
    await ACTION_REGISTRY.approve_walk_in.invoke(ctx);
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });

  test("reassign_mechanic opens the reassign dialog", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.reassign_mechanic.invoke(ctx);
    expect(ctx.openDialog).toHaveBeenCalledWith("reassign");
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });

  test("mark_paid opens the mark_paid dialog", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.mark_paid.invoke(ctx);
    expect(ctx.openDialog).toHaveBeenCalledWith("mark_paid");
  });
});

describe("complete_job soft-nudge for confirmed diagnosis", () => {
  test("completes directly when a confirmed diagnosis is already recorded", async () => {
    const ctx = makeCtx({
      order: makeOrder({ confirmedDiagnosis: "worn front pads" }),
    });
    await ACTION_REGISTRY.complete_job.invoke(ctx);
    expect(ctx.askReason).not.toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith("completed");
  });

  test("prompts when diagnosis is missing, saves the entry, then completes", async () => {
    const ctx = makeCtx({
      order: makeOrder({ confirmedDiagnosis: null }),
      askReason: mock(async () => "seized brake caliper"),
    });
    await ACTION_REGISTRY.complete_job.invoke(ctx);
    expect(ctx.saveConfirmedDiagnosis).toHaveBeenCalledWith(
      "seized brake caliper",
    );
    expect(ctx.transitionStatus).toHaveBeenCalledWith("completed");
  });

  test("completes without saving when the prompt is left blank", async () => {
    const ctx = makeCtx({
      order: makeOrder({ confirmedDiagnosis: null }),
      askReason: mock(async () => ""),
    });
    await ACTION_REGISTRY.complete_job.invoke(ctx);
    expect(ctx.saveConfirmedDiagnosis).not.toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith("completed");
  });

  test("aborts completion when the mechanic backs out of the prompt", async () => {
    const ctx = makeCtx({
      order: makeOrder({ confirmedDiagnosis: null }),
      askReason: mock(async () => null),
    });
    await ACTION_REGISTRY.complete_job.invoke(ctx);
    expect(ctx.saveConfirmedDiagnosis).not.toHaveBeenCalled();
    expect(ctx.transitionStatus).not.toHaveBeenCalled();
  });
});

describe("leadAction", () => {
  test("returns profile.primary when visible", () => {
    const o = makeOrder({
      status: "approved",
      scheduledAt: "x",
      providerId: 1,
    });
    const lead = leadAction(o);
    expect(lead?.id).toBe(STATUS_PROFILES.approved.primary);
    expect(lead?.id).toBe("start_job");
  });

  test("canonicalizes window-period legacy statuses to their profile", () => {
    // A physical 'scheduled' row (pre-remap) is canonically approved.
    const legacy = makeOrder({
      status: "scheduled" as OrderStatus,
      scheduledAt: "x",
      providerId: 1,
    });
    expect(leadAction(legacy)?.id).toBe("start_job");
    // A physical 'revised' row is canonically draft.
    const revised = makeOrder({ status: "revised" as OrderStatus });
    expect(leadAction(revised)?.id).toBe("send_to_customer");
  });

  test("falls through to next primary-variant action when profile.primary is hidden", () => {
    // draft+tentative: profile.primary=send_to_customer hides, falls to approve_walk_in
    const o = makeOrder({
      status: "draft",
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    const lead = leadAction(o);
    expect(lead?.id).toBe("approve_walk_in");
  });

  test("returns undefined when no primary candidate is visible", () => {
    const o = makeOrder({ status: "cancelled" });
    expect(leadAction(o)).toBeUndefined();
  });

  test("returns undefined when profile has no primary and no primary-variant actions visible", () => {
    // estimated profile has no .primary; its actions are approve/decline/cancel
    // — none are variant "primary".
    const o = makeOrder({ status: "estimated" });
    expect(leadAction(o)).toBeUndefined();
  });
});
