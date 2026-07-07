import { afterEach, expect, test } from "bun:test";
import { POST } from "./route";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockReq(headers: Record<string, string>) {
  return {
    json: async () => ({ messages: [] }),
    headers: { get: (k: string) => headers[k] ?? null },
    signal: undefined,
  } as unknown as Parameters<typeof POST>[0];
}

function captureUpstreamHeaders() {
  const box: { headers?: Record<string, string> } = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    box.headers = init.headers as Record<string, string>;
    return { ok: true, status: 200, body: null, headers: { get: () => null } };
  }) as unknown as typeof fetch;
  return box;
}

test("staff-chat proxy forwards X-Shop-Id + Authorization to the gateway", async () => {
  const box = captureUpstreamHeaders();
  await POST(mockReq({ Authorization: "Bearer t", "X-Shop-Id": "shop-123" }));
  expect(box.headers?.["X-Shop-Id"]).toBe("shop-123");
  expect(box.headers?.Authorization).toBe("Bearer t");
});

test("staff-chat proxy omits X-Shop-Id when the request has none", async () => {
  const box = captureUpstreamHeaders();
  await POST(mockReq({ Authorization: "Bearer t" }));
  expect(box.headers?.["X-Shop-Id"]).toBeUndefined();
});
