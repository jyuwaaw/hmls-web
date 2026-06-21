// Pure prompt construction for the single-shot brain run. No agent imports, so
// it's unit-testable without loading the heavy agent graph.

export interface DiagnoseOnceInput {
  vehicle: { year: number | string; make: string; model: string };
  symptom: string;
  dtcs?: string[];
}

/** The single-turn prompt the agent sees. Pure. */
export function buildDiagnosePrompt(input: DiagnoseOnceInput): string {
  const v = `${input.vehicle.year} ${input.vehicle.make} ${input.vehicle.model}`.trim();
  const dtcs = input.dtcs?.length ? ` OBD codes present: ${input.dtcs.join(", ")}.` : "";
  return `Vehicle: ${v}. Customer symptom: ${input.symptom}.${dtcs} ` +
    `Give your best diagnosis and a price estimate for the likely fix.`;
}

export function buildStructuredDiagnosePrompt(input: DiagnoseOnceInput): string {
  const v = `${input.vehicle.year} ${input.vehicle.make} ${input.vehicle.model}`.trim();
  const dtcs = input.dtcs?.length ? ` OBD codes present: ${input.dtcs.join(", ")}.` : "";
  return `Vehicle: ${v}. Customer symptom: ${input.symptom}.${dtcs}\n\n` +
    `Diagnose this as an expert mechanic. Use your tools to reason. This is a ONE-SHOT ` +
    `request — you will NOT get a reply, so do NOT ask the user questions; instead put any ` +
    `clarifying questions in the diagnosis's "to_confirm" field. Finish by calling ` +
    `emit_diagnosis exactly once with your complete structured diagnosis.`;
}

/** System-prompt addendum for the one-shot API path. Appended AFTER the default
 *  SYSTEM_PROMPT to override its "begin with intake, ask follow-ups" guidance —
 *  in this path the caller cannot answer, so the agent must always emit. Pure. */
export const ONESHOT_DIAGNOSIS_DIRECTIVE =
  "## ONE-SHOT API MODE (overrides any intake / conversation guidance above)\n" +
  "This is a single-shot API call. You will receive NO reply and the user CANNOT " +
  "answer questions. Do NOT call ask_user_question and do NOT ask for more information. " +
  "Use your tools to reason, then call emit_diagnosis EXACTLY ONCE with your best " +
  "structured diagnosis from the information given. Put anything you would otherwise ask " +
  "about — or that needs on-site confirmation — in the diagnosis's to_confirm field. " +
  "ALWAYS call emit_diagnosis, even when the symptom is sparse: give best-effort ranked " +
  "candidate systems rather than asking.";
