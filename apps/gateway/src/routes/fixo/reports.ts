import { Hono } from "hono";
import { renderToStream } from "@react-pdf/renderer";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { DiagnosticReportPdf } from "@hmls/agent";
import { getLogger } from "@logtape/logtape";
import type { AuthContext } from "../../middleware/fixo/auth.ts";

const logger = getLogger(["hmls", "gateway", "fixo", "reports"]);

type Variables = { auth: AuthContext };
const reports = new Hono<{ Variables: Variables }>();

// Shape that complete.ts and the 0016 backfill produce. Validated at render time
// rather than at the DB boundary because result is jsonb.
type FixoResultShape = {
  summary?: string;
  overallSeverity?: "critical" | "high" | "medium" | "low";
  issues?: Array<{
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    description: string;
    recommendedAction: string;
    estimatedCost?: string;
  }>;
  obdCodes?: Array<{
    code: string;
    meaning: string;
    severity: string;
  }>;
};

type VehicleSnapshotShape = {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  vin?: string | null;
} | null;

type MediaSnapshotShape = Array<{
  id: number;
  type: string;
  storageKey: string;
  transcription: string | null;
  createdAt: string | Date;
}>;

// GET /reports/:reportId/pdf — render PDF from a frozen report snapshot
reports.get("/:reportId/pdf", async (c) => {
  const auth = c.get("auth");
  const reportId = c.req.param("reportId");

  if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
    return c.json({ error: "Invalid report ID" }, 400);
  }

  const [report] = await db
    .select()
    .from(schema.fixoReports)
    .where(eq(schema.fixoReports.id, reportId))
    .limit(1);

  // D2: reports require an authenticated user — customer_id-only sessions
  // never produced a fixo_reports row, so userId match is sufficient.
  if (!report || report.userId !== auth.userId) {
    return c.json({ error: "Report not found" }, 404);
  }

  const rawResult = report.result as FixoResultShape;
  const result = {
    summary: rawResult.summary ?? "No summary available.",
    overallSeverity: rawResult.overallSeverity ?? "low",
    issues: rawResult.issues ?? [],
    obdCodes: rawResult.obdCodes,
  };
  const vehicle = report.vehicleSnapshot as VehicleSnapshotShape;
  const media = (report.mediaSnapshot ?? []) as MediaSnapshotShape;

  try {
    const pdfStream = await renderToStream(
      DiagnosticReportPdf({
        reportId: report.id,
        generatedAt: report.generatedAt,
        vehicle,
        media,
        result,
      }),
    );

    return new Response(pdfStream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Fixo-Report-${report.id}.pdf"`,
      },
    });
  } catch (err) {
    logger.error("PDF render failed", {
      reportId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "PDF render failed" }, 500);
  }
});

export { reports };
