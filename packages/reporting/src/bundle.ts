import { createHash } from "node:crypto";
import type { ReportExport } from "@touchmyapi/contracts";
import { renderExecutivePdf } from "./pdf-executive";
import { renderTechnicalPdf } from "./pdf-technical";
import { writeJsonExport } from "./json-export";
import { sanitizeReport, type ReportPlan, type ReportSource } from "./sanitize";
import { reportObjectKey, type ReportObjectKind } from "./storage";

export type GeneratedReportObject = Readonly<{
  kind: ReportObjectKind;
  objectKey: string;
  contentType: "application/json" | "application/pdf";
  body: Uint8Array;
  contractVersion: "report.json@1";
}>;

export function stableFindingId(assessmentId: string, sourceKey: string): string {
  const bytes = createHash("sha256")
    .update(`${assessmentId}:${sourceKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes.at(6) ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes.at(8) ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function generateReportObjects(
  accountId: string,
  source: ReportSource,
  plan: ReportPlan,
): Promise<readonly GeneratedReportObject[]> {
  if (plan !== "pro" && plan !== "lifetime") return Object.freeze([]);
  const report: ReportExport = sanitizeReport(source, plan);
  const [technical, executive] = await Promise.all([
    renderTechnicalPdf(report),
    renderExecutivePdf(report),
  ]);
  return Object.freeze([
    Object.freeze({
      kind: "json" as const,
      objectKey: reportObjectKey(accountId, report.assessmentId, "json"),
      contentType: "application/json" as const,
      body: writeJsonExport(report),
      contractVersion: "report.json@1" as const,
    }),
    Object.freeze({
      kind: "pdf_technical" as const,
      objectKey: reportObjectKey(accountId, report.assessmentId, "pdf_technical"),
      contentType: "application/pdf" as const,
      body: technical,
      contractVersion: "report.json@1" as const,
    }),
    Object.freeze({
      kind: "pdf_executive" as const,
      objectKey: reportObjectKey(accountId, report.assessmentId, "pdf_executive"),
      contentType: "application/pdf" as const,
      body: executive,
      contractVersion: "report.json@1" as const,
    }),
  ]);
}
