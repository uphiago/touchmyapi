import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssessmentWizard, assessmentWizardSteps } from "./assessment-wizard";
import { Assessments, QueueReview } from "./assessments";

const accountId = "00000000-0000-4000-8000-000000000101";
const timestamp = "2026-08-23T12:00:00.000Z";

describe("guided assessment journey", () => {
  it("presents every authorization step and the passive local boundary", () => {
    expect(assessmentWizardSteps.map((step) => step.key)).toEqual([
      "category",
      "target",
      "scope",
      "limits",
      "authorization",
      "review",
    ]);

    const markup = renderToStaticMarkup(
      <AssessmentWizard open busy={false} onClose={() => undefined} onCreate={() => undefined} />,
    );

    for (const label of ["Category", "Target", "Scope", "Limits", "Authorization", "Review"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("I confirm that I am authorized");
    expect(markup).toContain("surface-public-posture");
    expect(markup).toContain("No network request is executed by this local draft flow");
    expect(markup).not.toContain('value="web"');
  });

  it("requires a final server-boundary review before queueing", () => {
    const markup = renderToStaticMarkup(
      <QueueReview
        assessment={{
          id: "00000000-0000-4000-8000-000000000106",
          accountId,
          targetCategory: "surface",
          target: "example.test",
          scope: ["example.test"],
          playbookId: "surface-public-posture",
          playbookVersion: "1.0.0",
          status: "draft",
          jobId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }}
        busy={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain("Final queue review");
    expect(markup).toContain("Passive public posture");
    expect(markup).toContain("Confirm &amp; queue");
    expect(markup).toContain("terms@1");
  });

  it("explains queued state without claiming a real execution", () => {
    const markup = renderToStaticMarkup(
      <Assessments
        assessments={[
          {
            id: "00000000-0000-4000-8000-000000000106",
            accountId,
            targetCategory: "surface",
            target: "example.test",
            scope: [],
            playbookId: "surface-public-posture",
            playbookVersion: "1.0.0",
            status: "queued",
            jobId: "00000000-0000-4000-8000-000000000107",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]}
        busy={false}
        onCreate={() => undefined}
        onQueue={() => undefined}
      />,
    );

    expect(markup).toContain("Accepted by the local queue boundary");
    expect(markup).toContain("No runner execution is implied");
    expect(markup).not.toContain("completed assessment");
  });

  it("explains the server-gated delivery for each plan without unlocking it in the browser", () => {
    const free = renderToStaticMarkup(
      <Assessments
        assessments={[]}
        busy={false}
        plan="free_unverified"
        onCreate={() => undefined}
        onQueue={() => undefined}
      />,
    );
    expect(free).toContain("Passive posture summary");
    expect(free).toContain("The server filters every delivery");

    const pro = renderToStaticMarkup(
      <Assessments
        assessments={[]}
        busy={false}
        plan="pro"
        onCreate={() => undefined}
        onQueue={() => undefined}
      />,
    );
    expect(pro).toContain("Technical + executive PDF");
    expect(pro).toContain("Versioned JSON export");
  });
});
