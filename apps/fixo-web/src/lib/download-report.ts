"use client";

import { AGENT_URL } from "@/lib/config";

/**
 * Download a finalized report's PDF. Caller is responsible for ensuring the
 * report exists (e.g. by POSTing /sessions/:id/complete first, which returns
 * { reportId }).
 *
 * Used by the chat page (after /complete). Server-side, this is a stateless
 * read of the report row rendered to PDF — no LLM call, no quota impact.
 */
export async function downloadReportPdf(
  reportId: string,
  accessToken: string,
): Promise<void> {
  const res = await fetch(`${AGENT_URL}/reports/${reportId}/pdf`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? "Failed to generate report PDF");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Fixo-Report-${reportId}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
