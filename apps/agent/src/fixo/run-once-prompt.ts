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
