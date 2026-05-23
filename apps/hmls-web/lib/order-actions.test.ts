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
    openDialog: mock(() => {}),
    askReason: mock(async () => "reason"),
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

  test("confirm_tentative_booking requires scheduledAt + providerId", () => {
    const partial = makeOrder({
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: null,
    });
    expect(ACTION_REGISTRY.confirm_tentative_booking.visible(partial)).toBe(
      false,
    );

    const full = makeOrder({
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    expect(ACTION_REGISTRY.confirm_tentative_booking.visible(full)).toBe(true);
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
      ACTION_REGISTRY.cancel_order.variant(makeOrder({ status: "scheduled" })),
    ).toBe("danger");
  });

  test("reassign_mechanic label flips by providerId", () => {
    expect(
      ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: null })),
    ).toBe("Assign mechanic");
    expect(
      ACTION_REGISTRY.reassign_mechanic.label(makeOrder({ providerId: 7 })),
    ).toBe("Reassign mechanic");
  });

  test("reschedule label flips by scheduledAt", () => {
    expect(
      ACTION_REGISTRY.reschedule.label(makeOrder({ scheduledAt: null })),
    ).toBe("Set appointment time");
    expect(
      ACTION_REGISTRY.reschedule.label(
        makeOrder({ scheduledAt: "2026-05-25T10:00:00Z" }),
      ),
    ).toBe("Reschedule");
  });
});

describe("ACTION_REGISTRY.invoke behavior", () => {
  test("send_to_customer transitions to estimated", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.send_to_customer.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("estimated");
  });

  test("confirm_booking transitions to scheduled", async () => {
    const ctx = makeCtx();
    await ACTION_REGISTRY.confirm_booking.invoke(ctx);
    expect(ctx.transitionStatus).toHaveBeenCalledWith("scheduled");
  });

  test("reject_booking asks for reason and cancels", async () => {
    const ctx = makeCtx({ askReason: mock(async () => "customer no-show") });
    await ACTION_REGISTRY.reject_booking.invoke(ctx);
    expect(ctx.askReason).toHaveBeenCalled();
    expect(ctx.transitionStatus).toHaveBeenCalledWith(
      "cancelled",
      "customer no-show",
    );
  });

  test("reject_booking does nothing if user cancels the reason dialog", async () => {
    const ctx = makeCtx({ askReason: mock(async () => null) });
    await ACTION_REGISTRY.reject_booking.invoke(ctx);
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

describe("leadAction", () => {
  test("returns profile.primary when visible", () => {
    const o = makeOrder({
      status: "scheduled",
      scheduledAt: "x",
      providerId: 1,
    });
    const lead = leadAction(o);
    expect(lead?.id).toBe(STATUS_PROFILES.scheduled.primary);
  });

  test("falls through to next primary-variant action when profile.primary is hidden", () => {
    // draft+tentative: profile.primary=send_to_customer hides, falls to confirm_tentative_booking
    const o = makeOrder({
      status: "draft",
      scheduledAt: "2026-05-25T10:00:00Z",
      providerId: 7,
    });
    const lead = leadAction(o);
    expect(lead?.id).toBe("confirm_tentative_booking");
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
