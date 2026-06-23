// apps/gateway/src/routes/fixo/keys.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createApiKeyForUser, listApiKeysForUser, revokeApiKeyForUser } from "@hmls/agent";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

const createInput = z.object({ label: z.string().max(80).optional() });

export const keys = new Hono<{ Variables: { auth: AuthContext } }>();

keys.get("/", async (c) => c.json({ keys: await listApiKeysForUser(c.get("auth").userId) }));

keys.post("/", zValidator("json", createInput), async (c) => {
  const { label } = c.req.valid("json");
  const created = await createApiKeyForUser(c.get("auth").userId, label);
  return c.json(created, 201); // { id, key, label } — `key` is the plaintext, shown once
});

keys.delete("/:id", async (c) => {
  const ok = await revokeApiKeyForUser(c.get("auth").userId, c.req.param("id"));
  if (!ok) return c.json({ error: { code: "NOT_FOUND", message: "Key not found" } }, 404);
  return c.json({ ok: true });
});
