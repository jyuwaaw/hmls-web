export interface ToolContext {
  userId?: string;
  customerId?: number;
  /** Staff chat: the admin's email, used to build the Actor for
   *  order-state writes. Absent for customer chat. */
  adminEmail?: string;
  /** Fixo chat: the active fixo_sessions.id. Required by tools that
   *  mutate session-scoped state (e.g. update_diagnostic_state). */
  fixoSessionId?: number;
  /** Multi-tenancy: the shop this chat session belongs to. Staff agent:
   *  may be OWNER_ALL_SHOPS for owner-wide reads. Customer agent: always
   *  a concrete shopId (resolved at first-contact upsert). */
  shopId?: string;
}

// deno-lint-ignore no-explicit-any
export interface LegacyTool<P = any> {
  name: string;
  description: string;
  // deno-lint-ignore no-explicit-any
  schema: any;
  execute: (params: P, ctx?: ToolContext) => Promise<unknown>;
}

/** Convert existing tool arrays (name/schema/execute) to AI SDK tool records. */
// deno-lint-ignore no-explicit-any
export function convertTools(existingTools: LegacyTool[], ctx?: ToolContext): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const result: Record<string, any> = {};
  for (const t of existingTools) {
    result[t.name] = {
      description: t.description,
      inputSchema: t.schema,
      execute: (input: unknown) => t.execute(input, ctx),
    };
  }
  return result;
}
