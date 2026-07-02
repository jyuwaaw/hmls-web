import { ACTIVE_SHOP_KEY } from "./active-shop";
import { AGENT_URL } from "./config";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiClient = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  put: <T>(path: string, body?: unknown) => Promise<T>;
  delete: <T>(path: string) => Promise<T>;
};

export function createApiClient(
  token: string | null | undefined,
  shopId?: string,
): ApiClient {
  const buildInit = (method: string, body?: unknown): RequestInit => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (shopId) headers["X-Shop-Id"] = shopId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const res = await fetch(`${AGENT_URL}${path}`, buildInit(method, body));
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      // Self-heal a stale shop selection: if the persisted X-Shop-Id no longer
      // names a real shop, the gateway rejects EVERY admin request with
      // BAD_SHOP — including /api/admin/shops, so the owner can't use the
      // switcher to fix it (hard lockout). Clear the bad value and reload to
      // fall back to all-shops. Guarded on the key being set so this can't loop.
      if (
        res.status === 403 &&
        payload?.error?.code === "BAD_SHOP" &&
        typeof window !== "undefined" &&
        window.localStorage.getItem(ACTIVE_SHOP_KEY)
      ) {
        window.localStorage.removeItem(ACTIVE_SHOP_KEY);
        window.location.reload();
      }
      const message =
        payload?.error?.message ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, message, payload);
    }
    // 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  };

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    delete: <T>(path: string) => request<T>("DELETE", path),
  };
}
