// apps/agent/src/common/tools/schedule.ts
//
// Unified scheduling tool. Picks an appointment time on an existing order
// for both customer- and staff-side agents:
//   - customer agent: scoped to ctx.customerId (own orders only); duration
//     is derived from the order's labor items, NOT taken from LLM input —
//     a customer can pick when, never how long.
//   - staff agent:    no ownership constraint; may override the duration
//     (e.g. add buffer for a difficult job) via the optional override.
//
// Routes through the order-state harness (`attachSchedule`), so an
// `approved` order auto-advances to `scheduled` and a `scheduled` /
// `in_progress` order is updated in place.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { type AccessCtx, canWrite, orderAccessible } from "../../db/tenant.ts";
import { toolResult } from "@hmls/shared/tool-result";
import type { OrderItem } from "@hmls/shared/db/schema";
import { autoAssignProvider } from "../../services/auto-assign.ts";
import { attachSchedule } from "../../services/order-state.ts";
import {
  customerAgentActor,
  staffAgentActor,
  toolResultFromOrderState,
} from "../../services/order-state-tool.ts";
import type { ToolContext } from "../convert-tools.ts";

const MIN_DURATION_MINUTES = 30;
const FALLBACK_DURATION_MINUTES = 60;

/** Compute the canonical duration for an order from its labor items.
 *  Used as the source of truth for customer-driven scheduling — a
 *  customer cannot shrink the appointment by lying about the duration. */
function deriveDurationMinutes(
  items: OrderItem[] | null | undefined,
  existingDurationMinutes: number | null,
): number {
  const laborMinutes = (items ?? [])
    .filter((it) => it.category === "labor")
    .reduce((sum, it) => sum + (it.laborHours ?? 0) * 60, 0);
  if (laborMinutes > 0) {
    return Math.max(MIN_DURATION_MINUTES, Math.round(laborMinutes));
  }
  if (existingDurationMinutes && existingDurationMinutes > 0) {
    return existingDurationMinutes;
  }
  return FALLBACK_DURATION_MINUTES;
}

const scheduleOrderTool = {
  name: "schedule_order",
  description: "Pick an appointment time on an existing order. Use after `get_availability` " +
    "returns slots and the customer has chosen one. Works on `approved` orders " +
    "(advances them to `scheduled`) and on already-`scheduled` / `in_progress` " +
    "orders (pure reschedule). Duration is fixed by the order's labor items — " +
    "customers cannot override it. The shop assigns the mechanic separately.",
  schema: z.object({
    orderId: z.string().describe("The order ID to schedule"),
    scheduledAt: z
      .string()
      .describe("ISO 8601 timestamp of the chosen slot (from get_availability)"),
    /** Staff-only override. Customer agent input here is ignored —
     *  duration is always derived from the order's labor hours. */
    durationMinutesOverride: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "STAFF ONLY: override the auto-derived duration in minutes (e.g. " +
          "add buffer for a difficult job). Ignored when called from the " +
          "customer agent.",
      ),
  }),
  execute: async (
    params: {
      orderId: string;
      scheduledAt: string;
      durationMinutesOverride?: number;
    },
    ctx: ToolContext | undefined,
  ) => {
    const id = Number(params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ success: false, error: "Invalid order ID" });
    }

    const when = new Date(params.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return toolResult({ success: false, error: "scheduledAt is not a valid date" });
    }

    // Ownership pre-flight (WRITE). Customer may only schedule their own
    // order; staff only their shop's; owner-no-shop is read-only (rejected).
    // This subsumes the prior inline customerId check and adds the staff
    // shop scope + owner-write block.
    const ctxAccess: AccessCtx = { shopId: ctx?.shopId, customerId: ctx?.customerId };
    if (!canWrite(ctxAccess) || !(await orderAccessible(id, ctxAccess))) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    // Customer agent first (returns null if no customerId in ctx), then
    // staff agent fallback. Same pattern as common/tools/order.ts.
    const customerActor = customerAgentActor(ctx);
    const actor = customerActor ?? staffAgentActor(ctx);

    // Single SELECT for item / duration derivation (everyone). Ownership is
    // already enforced by the pre-flight above.
    const [order] = await db
      .select({
        id: schema.orders.id,
        customerId: schema.orders.customerId,
        items: schema.orders.items,
        durationMinutes: schema.orders.durationMinutes,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) {
      return toolResult({ success: false, error: `Order #${id} not found` });
    }

    const derived = deriveDurationMinutes(
      order.items as OrderItem[] | null,
      order.durationMinutes,
    );
    // Staff override only applies to the staff agent. Customers can't
    // shrink (or grow) the appointment via LLM input.
    const durationMinutes = !customerActor && params.durationMinutesOverride
      ? params.durationMinutesOverride
      : derived;

    const result = await attachSchedule(
      id,
      { scheduledAt: when, durationMinutes },
      actor,
    );
    if (!result.ok) {
      return toolResultFromOrderState(result, () => ({}));
    }

    // Uber-style auto-dispatch. If no mechanic is eligible (e.g. all booked),
    // we leave the order unassigned and surface that in the message — admin
    // can handle manually from the order detail action panel.
    const dispatched = result.value.providerId == null
      ? await autoAssignProvider(id)
      : { providerId: result.value.providerId as number };

    const friendlyTime = when.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    // Wording follows the order's actual lifecycle status. `scheduled` and
    // `in_progress` are both locked: scheduled means the shop confirmed
    // the appointment, in_progress means the mechanic is already on the
    // job and this call is a pure reschedule (per attachSchedule's
    // SCHEDULE_ATTACH_FROM allowlist). Drafts/estimated/revised orders
    // are tentative — the shop still needs to review and confirm before
    // it is a real booking, so the tool MUST NOT claim "confirmed" then.
    const finalStatus = result.value.status;
    const isLocked = finalStatus === "scheduled" ||
      finalStatus === "in_progress";
    const message = isLocked
      ? (dispatched.providerId
        ? `Appointment confirmed for ${friendlyTime}. A mechanic has been assigned and will be in touch.`
        : `Appointment set for ${friendlyTime}. We're finalizing the mechanic assignment — our team will confirm shortly.`)
      : `Tentatively scheduled for ${friendlyTime}, pending shop confirmation. The shop will review the estimate and lock in the appointment shortly — you'll get a notification once it's confirmed.`;

    return toolResult({
      success: true,
      orderId: result.value.id,
      newStatus: finalStatus,
      pendingShopReview: !isLocked,
      appointmentStart: result.value.scheduledAt?.toISOString(),
      appointmentEnd: result.value.appointmentEnd?.toISOString(),
      durationMinutes,
      providerId: dispatched.providerId,
      message,
    });
  },
};

export const scheduleTools = [scheduleOrderTool];
