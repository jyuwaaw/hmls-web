// Fails if a gateway route file queries a tenant table without a shopId filter.
// estimates.ts is intentionally excluded — its public routes use shareToken
// as the authorization proof and must remain unauthenticated / unscoped.
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

const EXCEPT = new Set([
  // estimates.ts: shareToken IS the authorization; scoping by shopId would
  // break anonymous share-token links. Intentionally left unscoped.
  "estimates.ts",
]);
const TENANT = /schema\.(orders|customers|providers)\b/;

Deno.test(
  "every gateway route that touches a tenant table scopes by shopId",
  async () => {
    const offenders: string[] = [];
    const routesDir = new URL("./routes", import.meta.url).pathname;
    for await (
      const entry of walk(routesDir, { exts: [".ts"] })
    ) {
      if (entry.name.endsWith("_test.ts") || EXCEPT.has(entry.name)) continue;
      const src = await Deno.readTextFile(entry.path);
      if (TENANT.test(src) && !src.includes("shopId")) {
        offenders.push(entry.name);
      }
    }
    assertEquals(offenders, []);
  },
);
