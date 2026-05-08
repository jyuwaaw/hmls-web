// Read + upsert helpers for the order_intake child table.
//
// `order_intake` holds customer-submitted intake (symptom narrative, photos,
// customer-side notes) — exists iff the order came in through the AI chat
// flow. Walk-in / direct admin orders have no intake row.

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import type { OrderIntakeRow } from "@hmls/shared/db/types";

/** Either the global `db` or a transaction handle from `db.transaction(...)`.
 *  Both expose the `insert` / `select` / `update` methods this module needs;
 *  only the global has `$client`, which is irrelevant here. */
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** All three intake fields are independently optional. `undefined` means
 *  "leave unchanged"; `null` means "explicitly clear". */
export interface IntakePatch {
  symptomDescription?: string | null;
  photoUrls?: string[] | null;
  customerNotes?: string | null;
}

/** Returns true if the patch carries at least one settable field — used to
 *  short-circuit the upsert when callers pass an empty patch. */
export function hasIntakeFields(patch: IntakePatch): boolean {
  return (
    patch.symptomDescription !== undefined ||
    patch.photoUrls !== undefined ||
    patch.customerNotes !== undefined
  );
}

/** Upsert intake fields for an order. Idempotent: creates the row on first
 *  call, updates non-undefined fields on subsequent calls. Pass a Drizzle
 *  transaction (`tx`) to participate in an outer transaction; defaults to
 *  the global `db` for standalone use. */
export async function upsertOrderIntake(
  orderId: number,
  patch: IntakePatch,
  tx: DbExecutor = db,
): Promise<void> {
  if (!hasIntakeFields(patch)) return;

  const insert: Record<string, unknown> = { orderId };
  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.symptomDescription !== undefined) {
    insert.symptomDescription = patch.symptomDescription;
    update.symptomDescription = patch.symptomDescription;
  }
  if (patch.photoUrls !== undefined) {
    insert.photoUrls = patch.photoUrls;
    update.photoUrls = patch.photoUrls;
  }
  if (patch.customerNotes !== undefined) {
    insert.customerNotes = patch.customerNotes;
    update.customerNotes = patch.customerNotes;
  }

  await tx
    .insert(schema.orderIntake)
    .values(insert as typeof schema.orderIntake.$inferInsert)
    .onConflictDoUpdate({
      target: schema.orderIntake.orderId,
      set: update,
    });
}

/** Fetch the intake row for one order, or null if none exists. */
export async function getOrderIntake(orderId: number): Promise<OrderIntakeRow | null> {
  const [row] = await db
    .select()
    .from(schema.orderIntake)
    .where(eq(schema.orderIntake.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/** Batch-fetch intake rows for many orders. Returns a Map keyed by orderId.
 *  Orders without an intake row are absent from the map (caller should treat
 *  `map.get(id) ?? null` as "no intake"). */
export async function getIntakeMap(
  orderIds: number[],
): Promise<Map<number, OrderIntakeRow>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.orderIntake)
    .where(inArray(schema.orderIntake.orderId, orderIds));
  return new Map(rows.map((r) => [r.orderId, r]));
}
