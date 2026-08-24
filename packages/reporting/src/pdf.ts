import React from "react";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ReportExport } from "@touchmyapi/contracts";

const styles = StyleSheet.create({
  page: {
    backgroundColor: "#f7f5ee",
    color: "#18211d",
    fontFamily: "Helvetica",
    fontSize: 9,
    lineHeight: 1.45,
    paddingBottom: 48,
    paddingHorizontal: 42,
    paddingTop: 42,
  },
  brand: { color: "#22785c", fontSize: 8, letterSpacing: 2, marginBottom: 12 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 21, marginBottom: 18 },
  line: { marginBottom: 3 },
  footer: { bottom: 20, color: "#607067", fontSize: 7, left: 42, position: "absolute" },
});

function linesForValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(linesForValue);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      `${key}:`,
      ...linesForValue(nested).map((line) => `  ${line}`),
    ]);
  }
  return [String(value)];
}

/** Renders a paginated, deterministic server-side PDF with no external fonts or assets. */
export async function renderPdf(
  title: string,
  lines: string[],
  generatedAt: string,
): Promise<Uint8Array> {
  const fixedDate = new Date(generatedAt);
  const document = React.createElement(
    Document,
    {
      author: "TouchMyAPI",
      creator: "TouchMyAPI deterministic reporting",
      producer: "TouchMyAPI",
      title,
      creationDate: fixedDate,
      modificationDate: fixedDate,
    },
    React.createElement(
      Page,
      { size: "A4", style: styles.page, wrap: true },
      React.createElement(Text, { style: styles.brand }, "TOUCHMYAPI / AUTHORIZED SECURITY"),
      React.createElement(Text, { style: styles.title }, title),
      React.createElement(
        View,
        null,
        ...lines.map((line, index) =>
          React.createElement(Text, { key: `${index}:${line}`, style: styles.line }, line || " "),
        ),
      ),
      React.createElement(Text, {
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `Page ${pageNumber} / ${totalPages}`,
        style: styles.footer,
      }),
    ),
  );
  return new Uint8Array(await renderToBuffer(document));
}

export function reportLines(report: ReportExport): string[] {
  return [
    `Assessment ${report.assessmentId}`,
    `Generated ${report.generatedAt}`,
    `Plan ${report.plan}`,
    "",
    "Methodology",
    ...report.methodology.map((item) => `- ${item}`),
    "",
    "Scope",
    ...report.scope.inclusions.map((item) => `Included: ${item}`),
    ...report.scope.exclusions.map((item) => `Excluded: ${item}`),
    `Window: ${report.scope.window.start} to ${report.scope.window.end}`,
    "",
    "Limitations",
    ...report.limitations.map((item) => `- ${item}`),
  ];
}

export function findingLines(report: ReportExport): string[] {
  return report.findings.flatMap((finding) => [
    `${finding.severity.toUpperCase()}: ${finding.title} (${finding.category})`,
    ...(finding.impact ? [`Impact: ${finding.impact}`] : []),
    ...(finding.remediation ? [`Remediation: ${finding.remediation}`] : []),
    ...(finding.reproduction
      ? ["Reproduction:", ...finding.reproduction.map((item) => `- ${item}`)]
      : []),
    ...(finding.evidence ? ["Evidence:", ...linesForValue(finding.evidence)] : []),
    "",
  ]);
}
