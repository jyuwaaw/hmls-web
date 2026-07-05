// apps/agent/src/common/tools/claim-shop.ts
//
// First-order claiming: a customer's home shop is stamped by signup/chat
// defaults, not geography. On their FIRST order, if it routes to a different
// shop than the customer's home shop, we adopt that order's shop so the
// customer lands in the right shop's book. Pure decision extracted for unit
// testing — the DB side-effects (prior-order lookup + update) live in order.ts.

/** Decide whether a customer's home shop should be claimed by an order's shop. */
export function shouldClaimShop(
  hasPriorOrders: boolean,
  customerShopId: string,
  orderShopId: string,
): boolean {
  return !hasPriorOrders && customerShopId !== orderShopId;
}
