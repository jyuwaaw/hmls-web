// Mint a Fixo public-API key. Stores only the HASH in fixo_api_keys; prints the
// plaintext ONCE. Requires migration 0028 applied. Writes to the DB, so run via
// Infisical (= prod):
//
//   infisical run --env=dev -- deno run -A apps/agent/src/scripts/mint-fixo-key.ts "label here"

import { generateApiKey } from "../fixo/lib/api-keys.ts";
import { db, schema } from "../db/client.ts";

const label = Deno.args.join(" ").trim() || "dogfood";
const { key, hash } = generateApiKey();

await db.insert(schema.fixoApiKeys).values({ keyHash: hash, label });

console.log("Minted Fixo API key (shown once — store it now):");
console.log(`  ${key}`);
console.log(`  label: ${label}`);

// ponytail: the postgres pool keeps the event loop alive, so the CLI never
// exits on its own. The insert above is awaited, so force-exit after printing.
Deno.exit(0);
