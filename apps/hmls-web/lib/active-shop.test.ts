import { describe, expect, test } from "bun:test";
import {
  ACTIVE_SHOP_KEY,
  clearActiveShop,
  readActiveShop,
  writeActiveShop,
} from "./active-shop";

describe("active shop persistence", () => {
  test("round-trips a shop id through a storage stub", () => {
    const store: Record<string, string> = {};
    const stub = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    } as Storage;
    expect(readActiveShop(stub)).toBeNull();
    writeActiveShop(stub, "abc");
    expect(store[ACTIVE_SHOP_KEY]).toBe("abc");
    expect(readActiveShop(stub)).toBe("abc");
  });
  test("readActiveShop tolerates a missing storage (SSR)", () => {
    expect(readActiveShop(undefined)).toBeNull();
  });
  test("clearActiveShop removes the persisted selection (back to all shops)", () => {
    const store: Record<string, string> = {};
    const stub = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    } as Storage;
    writeActiveShop(stub, "abc");
    clearActiveShop(stub);
    expect(readActiveShop(stub)).toBeNull();
    expect(() => clearActiveShop(undefined)).not.toThrow(); // SSR-safe
  });
});
