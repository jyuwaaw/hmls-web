import { createDbClient } from "@hmls/shared/db";
import * as schema from "@hmls/shared/db/schema";

export const db = createDbClient(schema);
export { schema };
export type { FixoMedia, OrderItem } from "@hmls/shared/db/schema";
export * from "./tenant.ts";
