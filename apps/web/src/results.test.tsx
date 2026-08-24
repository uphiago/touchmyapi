import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultsWorkspace } from "./results";

const accountId = "00000000-0000-4000-8000-000000000101";
const assessmentId = "00000000-0000-4000-8000-000000000106";
const timestamp = "2026-08-23T12:00:00.000Z";

const assessment = {
  id: assessmentId,
  accountId,
  targetCategory: "surface" as const,
  target: "example.test",
  scope: ["example.test"],
  playbookId: "surface-public-posture",
  playbookVersion: "1.0.0",
  status: "completed" as const,
  jobId: "00000000-0000-4000-8000-000000000107",
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("assessment result delivery", () => {
  it("does not imply that production queueing means execution is already active", () => {
    const markup = renderToStaticMarkup(
      <ResultsWorkspace
        assessments={[{ ...assessment, status: "queued" }]}
        selectedAssessmentId={assessmentId}
        delivery={{
          assessmentId,
          status: "queued",
          visibility: "aggregate",
          summary: { total: 0, bySeverity: {}, byCategory: {} },
          findings: [],
        }}
        notifications={[]}
        reports={[]}
        plan="pro"
        busy={false}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onMarkRead={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup).toContain("Processing is not active in this environment yet");
    expect(markup).toContain("remains queued");
  });

  it("makes server-selected delivery visibility explicit and keeps aggregate findings hidden", () => {
    const markup = renderToStaticMarkup(
      <ResultsWorkspace
        assessments={[assessment]}
        selectedAssessmentId={assessmentId}
        delivery={{
          assessmentId,
          status: "completed",
          visibility: "aggregate",
          summary: { total: 2, bySeverity: { high: 1, low: 1 }, byCategory: { exposure: 2 } },
          findings: [],
        }}
        notifications={[]}
        reports={[]}
        plan="free_unverified"
        busy={false}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onMarkRead={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup).toContain("Aggregate delivery");
    expect(markup).toContain("2 findings");
    expect(markup).toContain("Finding detail is reserved for an eligible plan");
    expect(markup).toContain("Reports require an upgrade");
    expect(markup).not.toContain("example finding");
  });

  it("renders detailed findings, unread notifications, and available reports", () => {
    const markup = renderToStaticMarkup(
      <ResultsWorkspace
        assessments={[assessment]}
        selectedAssessmentId={assessmentId}
        delivery={{
          assessmentId,
          status: "completed",
          visibility: "detailed",
          summary: { total: 1, bySeverity: { critical: 1 }, byCategory: { exposure: 1 } },
          findings: [
            {
              id: "00000000-0000-4000-8000-000000000108",
              title: "Publicly exposed admin endpoint",
              category: "exposure",
              severity: "critical",
              endpoint: "https://example.test/admin",
              evidence: null,
              reproduction: ["Open the endpoint in a browser"],
              impact: "Administrative controls may be reachable.",
              remediation: "Restrict the endpoint.",
            },
          ],
        }}
        notifications={[
          {
            id: "00000000-0000-4000-8000-000000000109",
            assessmentId,
            kind: "assessment_completed",
            readAt: null,
            createdAt: timestamp,
          },
        ]}
        reports={[
          {
            id: "00000000-0000-4000-8000-000000000110",
            assessmentId,
            kind: "pdf_technical",
            contractVersion: "report.pdf@1",
            generatedAt: timestamp,
          },
        ]}
        plan="pro"
        busy={false}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onMarkRead={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup).toContain("Detailed delivery");
    expect(markup).toContain("Publicly exposed admin endpoint");
    expect(markup).toContain("Notifications");
    expect(markup).toContain("1 unread");
    expect(markup).toContain("Technical PDF");
    expect(markup).toContain("Mark read");
    expect(markup).toContain("Download");
  });
});
