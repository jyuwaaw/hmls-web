import { Hono } from "hono";
import { db, schema } from "@hmls/agent/db";
import { eq } from "drizzle-orm";
import { DiagnosticReportPdf } from "@hmls/agent";
import { getLogger } from "@logtape/logtape";
import type { AuthContext } from "../../middleware/fixo/auth.ts";
import { pdfResponse } from "../../lib/pdf-response.ts";

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

// Mirrors the snapshot complete.ts writes from a fixo_estimates row. NULL when
// the session never produced an estimate. Validated at render time, not the DB
// boundary (jsonb).
type EstimateSnapshotShape = {
  items?: Array<{
    name: string;
    description?: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    category: "labor" | "parts" | "fee" | "discount" | "tax";
    tier?: "required" | "recommended" | "maintenance" | "optional";
  }>;
  subtotalCents?: number;
  priceRangeLowCents?: number;
  priceRangeHighCents?: number;
  validDays?: number;
  expiresAt?: string | Date;
} | null;

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
  const rawEstimate = report.estimateSnapshot as EstimateSnapshotShape;
  // PDF expects items[] to exist; treat snapshots missing items as no-estimate.
  const estimate = rawEstimate && rawEstimate.items && rawEstimate.items.length > 0
    ? {
      items: rawEstimate.items,
      subtotalCents: rawEstimate.subtotalCents ?? 0,
      priceRangeLowCents: rawEstimate.priceRangeLowCents ?? 0,
      priceRangeHighCents: rawEstimate.priceRangeHighCents ?? 0,
      validDays: rawEstimate.validDays,
      expiresAt: rawEstimate.expiresAt,
    }
    : null;

  try {
    return await pdfResponse(
      DiagnosticReportPdf({
        reportId: report.id,
        generatedAt: report.generatedAt,
        vehicle,
        media,
        result,
        estimate,
      }),
      `Fixo-Report-${report.id}.pdf`,
    );
  } catch (err) {
    logger.error("PDF render failed", {
      reportId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "PDF render failed" }, 500);
  }
});

export { reports };
