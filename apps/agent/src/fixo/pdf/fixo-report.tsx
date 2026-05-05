// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

const RED = "#dc2626";

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#1a1a1a",
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: RED,
  },
  logo: {
    fontSize: 24,
    fontWeight: "bold",
    color: RED,
  },
  logoSubtext: {
    fontSize: 10,
    color: "#666666",
    marginTop: 4,
  },
  titleSection: {
    textAlign: "right",
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#1a1a1a",
  },
  sessionId: {
    fontSize: 10,
    color: "#666666",
    marginTop: 4,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "bold",
    color: RED,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  vehicleInfo: {
    backgroundColor: "#f9fafb",
    padding: 15,
    borderRadius: 4,
  },
  vehicleName: {
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 4,
  },
  vehicleDetail: {
    fontSize: 10,
    color: "#666666",
    marginBottom: 2,
  },
  summaryBox: {
    backgroundColor: "#f9fafb",
    padding: 15,
    borderRadius: 4,
  },
  summaryText: {
    fontSize: 11,
    lineHeight: 1.5,
  },
  severityBadge: {
    fontSize: 10,
    fontWeight: "bold",
    padding: "4 10",
    borderRadius: 4,
    alignSelf: "flex-start",
    marginBottom: 8,
  },
  severityCritical: {
    backgroundColor: "#fee2e2",
    color: "#dc2626",
  },
  severityHigh: {
    backgroundColor: "#fef3c7",
    color: "#d97706",
  },
  severityMedium: {
    backgroundColor: "#fef9c3",
    color: "#ca8a04",
  },
  severityLow: {
    backgroundColor: "#dcfce7",
    color: "#16a34a",
  },
  table: {
    marginTop: 10,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f3f4f6",
    padding: 10,
    fontWeight: "bold",
    fontSize: 10,
  },
  tableRow: {
    flexDirection: "row",
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  issueRow: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  issueTitle: {
    fontSize: 11,
    fontWeight: "bold",
    marginBottom: 4,
  },
  issueDescription: {
    fontSize: 10,
    color: "#4b5563",
    marginBottom: 4,
  },
  issueAction: {
    fontSize: 10,
    color: RED,
  },
  issueCost: {
    fontSize: 10,
    color: "#666666",
    marginTop: 2,
  },
  colCode: {
    flex: 1,
    fontFamily: "Courier",
  },
  colMeaning: {
    flex: 3,
  },
  colSeverity: {
    flex: 1,
    textAlign: "right",
  },
  footer: {
    position: "absolute",
    bottom: 40,
    left: 40,
    right: 40,
  },
  disclaimer: {
    fontSize: 9,
    color: "#666666",
    marginBottom: 15,
    padding: 10,
    backgroundColor: "#f9fafb",
    borderRadius: 4,
  },
  generatedAt: {
    fontSize: 9,
    color: "#666666",
    textAlign: "center",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingTop: 10,
  },
});

interface FixoIssue {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  recommendedAction: string;
  estimatedCost?: string;
}

interface ObdCodeResult {
  code: string;
  meaning: string;
  severity: string;
}

interface FixoResult {
  summary: string;
  overallSeverity: "critical" | "high" | "medium" | "low";
  issues: FixoIssue[];
  obdCodes?: ObdCodeResult[];
}

// Frozen vehicle row at report-generation time (may be null when no vehicle was attached).
interface VehicleSnapshot {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  vin?: string | null;
}

// One frozen media row at report-generation time.
// Image embedding is intentionally omitted — we'd need to re-sign storageKey at
// render time, and v1 of the snapshot-rendered PDF only surfaces transcriptions
// + counts. See reports.ts.
export interface MediaSnapshotEntry {
  id: number;
  type: string;
  storageKey: string;
  transcription: string | null;
  createdAt: string | Date;
}

interface FixoReportProps {
  reportId: string;
  generatedAt: Date | string;
  vehicle?: VehicleSnapshot | null;
  media: MediaSnapshotEntry[];
  result: FixoResult;
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatVehicle(vehicle?: VehicleSnapshot | null): string {
  if (!vehicle) return "Not specified";
  const parts = [
    vehicle.year?.toString(),
    vehicle.make,
    vehicle.model,
  ].filter(Boolean);
  return parts.join(" ") || "Not specified";
}

function getSeverityStyle(severity: string) {
  switch (severity) {
    case "critical":
      return styles.severityCritical;
    case "high":
      return styles.severityHigh;
    case "medium":
      return styles.severityMedium;
    default:
      return styles.severityLow;
  }
}

export function DiagnosticReportPdf({
  reportId,
  generatedAt,
  vehicle,
  media,
  result,
}: FixoReportProps) {
  const mediaCount = media.length;
  const transcriptions = media.filter((m) => m.transcription && m.transcription.trim().length > 0);
  const shortReportId = reportId.slice(0, 8);
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.logo}>HMLS</Text>
            <Text style={styles.logoSubtext}>Fixo Vehicle Report</Text>
          </View>
          <View style={styles.titleSection}>
            <Text style={styles.title}>REPORT</Text>
            <Text style={styles.sessionId}>Report #{shortReportId}</Text>
            <Text style={styles.sessionId}>{formatDate(generatedAt)}</Text>
          </View>
        </View>

        {/* Vehicle Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vehicle</Text>
          <View style={styles.vehicleInfo}>
            <Text style={styles.vehicleName}>{formatVehicle(vehicle)}</Text>
            {vehicle?.vin && <Text style={styles.vehicleDetail}>VIN: {vehicle.vin}</Text>}
          </View>
        </View>

        {/* Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.summaryBox}>
            <Text style={[styles.severityBadge, getSeverityStyle(result.overallSeverity)]}>
              {result.overallSeverity.toUpperCase()}
            </Text>
            <Text style={styles.summaryText}>{result.summary}</Text>
          </View>
        </View>

        {/* Issues */}
        {result.issues.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Issues Found ({result.issues.length})
            </Text>
            <View style={styles.table}>
              {result.issues.map((issue, i) => (
                <View key={i} style={styles.issueRow}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={styles.issueTitle}>{issue.title}</Text>
                    <Text style={[styles.severityBadge, getSeverityStyle(issue.severity)]}>
                      {issue.severity.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.issueDescription}>{issue.description}</Text>
                  <Text style={styles.issueAction}>
                    Recommended: {issue.recommendedAction}
                  </Text>
                  {issue.estimatedCost && (
                    <Text style={styles.issueCost}>
                      Estimated cost: {issue.estimatedCost}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* OBD Codes */}
        {result.obdCodes && result.obdCodes.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>OBD-II Codes</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.colCode}>Code</Text>
                <Text style={styles.colMeaning}>Description</Text>
                <Text style={styles.colSeverity}>Severity</Text>
              </View>
              {result.obdCodes.map((obd, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.colCode}>{obd.code}</Text>
                  <Text style={styles.colMeaning}>{obd.meaning}</Text>
                  <Text style={styles.colSeverity}>{obd.severity}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Media Summary */}
        {mediaCount > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Media Analyzed</Text>
            <Text>
              {mediaCount} file(s) were submitted and analyzed during this session.
            </Text>
            {transcriptions.length > 0 && (
              <View style={{ marginTop: 8 }}>
                {transcriptions.map((m) => (
                  <Text key={m.id} style={styles.issueDescription}>
                    {m.type}: {m.transcription}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.disclaimer}>
            This report is generated by AI-powered diagnostic analysis and is intended for
            informational purposes only. It does not replace a professional mechanic inspection.
            Always consult a certified technician for safety-critical repairs. Estimated costs are
            approximate and may vary by location and shop.
          </Text>
          <Text style={styles.generatedAt}>
            Generated by Fixo | {formatDate(new Date())}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
