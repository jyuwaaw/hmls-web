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
