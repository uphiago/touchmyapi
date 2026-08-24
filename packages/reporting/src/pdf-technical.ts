import type { ReportExport } from "@touchmyapi/contracts";
import { renderPdf, reportLines, findingLines } from "./pdf";

export function renderTechnicalPdf(report: ReportExport): Promise<Uint8Array> {
  return renderPdf(
    "Technical security assessment report",
    [
      "Technical security assessment report",
      ...reportLines(report),
      "",
      "Untested items and scope limitations are explicitly listed above.",
      "Conclusions distinguish observed facts from inference where applicable.",
      "",
      "Findings appendix",
      ...findingLines(report),
    ],
    report.generatedAt,
  );
}
