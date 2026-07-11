import { describe, expect, test } from "bun:test";
import { STAFF_CHAT_STORAGE_KEY } from "@/hooks/useChatStorage";
import {
  ORDER_CHAT_STORAGE_PREFIX,
  orderChatBody,
  orderChatStorageKey,
} from "./order-chat";

describe("orderChatStorageKey", () => {
  test("isolates by orderId", () => {
    expect(orderChatStorageKey("shop-1", 42)).not.toBe(
      orderChatStorageKey("shop-1", 43),
    );
  });

  test("isolates by shopId", () => {
    expect(orderChatStorageKey("shop-1", 42)).not.toBe(
      orderChatStorageKey("shop-2", 42),
    );
  });

  test("never collides with the global staff chat key", () => {
    expect(orderChatStorageKey("shop-1", 42)).not.toBe(STAFF_CHAT_STORAGE_KEY);
    expect(orderChatStorageKey(null, 1)).not.toBe(STAFF_CHAT_STORAGE_KEY);
    // The global key must not be swept by the prefix-based sign-out clear.
    expect(STAFF_CHAT_STORAGE_KEY.startsWith(ORDER_CHAT_STORAGE_PREFIX)).toBe(
      false,
    );
  });

  test("null/undefined shopId falls back to a stable default bucket", () => {
    expect(orderChatStorageKey(null, 42)).toBe(
      orderChatStorageKey(undefined, 42),
    );
    expect(orderChatStorageKey(null, 42)).toBe("hmls-staff-chat:default:42");
  });

  test("keys live under the sweep prefix", () => {
    expect(
      orderChatStorageKey("shop-1", 42).startsWith(ORDER_CHAT_STORAGE_PREFIX),
    ).toBe(true);
  });
});

describe("orderChatBody", () => {
  test("carries a numeric orderId from a string route param", () => {
    expect(orderChatBody("42")).toEqual({ orderId: 42 });
  });

  test("carries a numeric orderId as-is", () => {
    expect(orderChatBody(7)).toEqual({ orderId: 7 });
  });
});
