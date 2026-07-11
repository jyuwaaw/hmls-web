/** Pure helpers for the embedded order chat panel (PR 6). Kept out of the
 * component so key derivation and the request-body seam are unit-testable. */

/** Prefix for per-order staff chat histories in localStorage. Distinct from
 * the global staff key ("hmls-staff-chat-history") — the ":" separator
 * guarantees no collision. Sign-out sweeps everything under this prefix
 * (see clearAllChatStorage in hooks/useChatStorage.ts). */
export const ORDER_CHAT_STORAGE_PREFIX = "hmls-staff-chat:";

/** Chat-history key isolated per shop + order (design C5): order A's
 * transcript must never seed the agent's context on order B, and an owner
 * switching shops must not see another shop's transcript for the same
 * order id. */
export function orderChatStorageKey(
  shopId: string | null | undefined,
  orderId: string | number,
): string {
  // ponytail: non-owner admins have no client-side shopId (server resolves
  // it) → "default" bucket. Fine per browser profile; sign-out clears all.
  return `${ORDER_CHAT_STORAGE_PREFIX}${shopId || "default"}:${orderId}`;
}

/** Extra request-body fields sent with EVERY message from the embedded
 * panel — the gateway uses orderId to seed the agent with this order. */
export function orderChatBody(orderId: string | number): { orderId: number } {
  return { orderId: Number(orderId) };
}
