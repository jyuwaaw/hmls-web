export const ACTIVE_SHOP_KEY = "hmls-admin-active-shop";

export function readActiveShop(storage: Storage | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(ACTIVE_SHOP_KEY);
  } catch {
    return null;
  }
}

export function writeActiveShop(
  storage: Storage | undefined,
  shopId: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_SHOP_KEY, shopId);
  } catch {
    /* storage unavailable */
  }
}

/** Back to "all shops": no X-Shop-Id is sent until a shop is picked again. */
export function clearActiveShop(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_SHOP_KEY);
  } catch {
    /* storage unavailable */
  }
}
