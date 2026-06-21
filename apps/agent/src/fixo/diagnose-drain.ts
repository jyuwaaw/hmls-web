// Pure stream-drain helper: scans collected stream parts for an emit_diagnosis
// tool-result. Kept in its own file so tests can import it without loading the
// heavy agent graph (runFixoAgent / agent.ts).

/**
 * Scan drained stream parts for the `emit_diagnosis` tool output.
 * Returns the last one found, or null if the agent never called it.
 */
export function pickEmitDiagnosis(
  parts: { type: string; toolName?: string; output?: unknown; result?: unknown }[],
): unknown {
  let found: unknown = null;
  for (const p of parts) {
    if (p.type === "tool-result" && p.toolName === "emit_diagnosis") {
      found = p.output ?? p.result ?? null;
    }
  }
  return found;
}
