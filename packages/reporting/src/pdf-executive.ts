import type { ReportExport } from "@touchmyapi/contracts";
import { renderPdf, reportLines } from "./pdf";

export function renderExecutivePdf(report: ReportExport): Promise<Uint8Array> {
  const counts = new Map<string, number>();
  for (const finding of report.findings)
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const risk = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  return renderPdf(
    "Executive security assessment report",
    [
      "Executive security assessment report",
      ...reportLines(report),
      "",
      "Risk summary",
      ...(risk.length > 0
        ? risk.map(([severity, count]) => `${severity}: ${count}`)
        : ["No findings"]),
      "",
      "Priorities",
      "Address high and critical severity findings first.",
      "",
      "Trend",
      "This report is a point-in-time assessment; historical comparison requires another run.",
      "",
      "Action plan",
      "Validate remediation, rerun the assessment, and review remaining limitations.",
    ],
    report.generatedAt,
  );
}
