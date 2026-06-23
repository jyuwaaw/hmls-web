// Fixo public-API key handling.
//
// Keys are high-entropy random tokens, so we store a SHA-256 hash (fast,
// per-request) rather than bcrypt (which is for low-entropy passwords). The
// plaintext is shown ONCE at mint time and never persisted — only the hash
// lands in fixo_api_keys, looked up by its unique index.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";

const KEY_PREFIX = "fixo_sk_";

/** Deterministic SHA-256 hex of a key. Same input → same hash; this is what
 *  we store and look up by. Never store the plaintext key. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Mint a new key: the plaintext (return to the caller ONCE) + its storage
 *  hash. 32 random bytes base64url-encoded behind the `fixo_sk_` prefix. */
export function generateApiKey(): { key: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key) };
}

/** Looks the presented key up by its hash among non-revoked rows. Returns the
 *  key row (id + label) on a hit, null otherwise. Bumps last_used_at on hit.
 *  Read-then-write is fine: last_used_at is advisory, not a security boundary. */
export async function verifyApiKey(
  presented: string,
): Promise<{ id: string; label: string | null } | null> {
  if (!presented.startsWith(KEY_PREFIX)) return null;
  const hash = hashApiKey(presented);
  const [row] = await db
    .select({ id: schema.fixoApiKeys.id, label: schema.fixoApiKeys.label })
    .from(schema.fixoApiKeys)
    .where(and(eq(schema.fixoApiKeys.keyHash, hash), isNull(schema.fixoApiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db
    .update(schema.fixoApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.fixoApiKeys.id, row.id));
  return row;
}

export async function createApiKeyForUser(
  userId: string,
  label?: string,
): Promise<{ id: string; key: string; label: string | null }> {
  const { key, hash } = generateApiKey();
  const [row] = await db.insert(schema.fixoApiKeys)
    .values({ keyHash: hash, label: label ?? null, userId })
    .returning({ id: schema.fixoApiKeys.id, label: schema.fixoApiKeys.label });
  return { id: row.id, key, label: row.label };
}

export async function listApiKeysForUser(userId: string) {
  const rows = await db.select({
    id: schema.fixoApiKeys.id,
    label: schema.fixoApiKeys.label,
    createdAt: schema.fixoApiKeys.createdAt,
    lastUsedAt: schema.fixoApiKeys.lastUsedAt,
    revokedAt: schema.fixoApiKeys.revokedAt,
  }).from(schema.fixoApiKeys)
    .where(eq(schema.fixoApiKeys.userId, userId))
    .orderBy(desc(schema.fixoApiKeys.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revoked: r.revokedAt !== null,
  }));
}

/** Revoke only if the key belongs to userId AND is not already revoked. */
export async function revokeApiKeyForUser(userId: string, id: string): Promise<boolean> {
  const updated = await db.update(schema.fixoApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(schema.fixoApiKeys.id, id),
      eq(schema.fixoApiKeys.userId, userId),
      isNull(schema.fixoApiKeys.revokedAt),
    ))
    .returning({ id: schema.fixoApiKeys.id });
  return updated.length > 0;
}
