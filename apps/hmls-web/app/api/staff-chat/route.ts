import type { NextRequest } from "next/server";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://api.hmls.autos";

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const authorization = req.headers.get("Authorization");
    // Forward the tenant header so the staff/owner chat is scoped to the
    // selected shop (matches api-client.ts CRUD requests). Without it an owner
    // is always OWNER_ALL in chat and can't create orders / scope reads.
    const shopId = req.headers.get("X-Shop-Id");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authorization) {
      headers.Authorization = authorization;
    }
    if (shopId) {
      headers["X-Shop-Id"] = shopId;
    }

    const upstream = await fetch(`${GATEWAY_URL}/api/admin/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(json),
      signal: req.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(errText || `Upstream error: ${upstream.status}`, {
        status: upstream.status,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        "x-vercel-ai-ui-message-stream":
          upstream.headers.get("x-vercel-ai-ui-message-stream") ?? "v1",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: "proxy_error", message, gateway: GATEWAY_URL }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
