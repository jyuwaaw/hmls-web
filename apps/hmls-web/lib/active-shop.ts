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
