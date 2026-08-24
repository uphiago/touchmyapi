import { useMemo, useState } from "react";
import type { Assessment, AssessmentCreate } from "../../../packages/contracts/src";
import { AssessmentWizard } from "./assessment-wizard";

export type AssessmentsProps = Readonly<{
  assessments: readonly Assessment[];
  busy: boolean;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
  onQueue: (assessmentId: string) => void | Promise<void>;
}>;

export function Assessments({ assessments, busy, onCreate, onQueue }: AssessmentsProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const visible = useMemo(
    () => assessments.filter((assessment) => filter === "all" || assessment.status === filter),
    [assessments, filter],
  );

  return (
    <div className="view-stack">
      <section className="page-intro page-intro--compact">
        <div>
          <span className="eyebrow">Assessment operations</span>
          <h1>Authorized work, one state at a time.</h1>
          <p>Draft intent, review the boundary, then queue it through the server.</p>
        </div>
        <button
          className="button button--primary button--inline"
          type="button"
          onClick={() => setWizardOpen(true)}
        >
          ＋ New assessment
        </button>
      </section>
      <section className="section-block assessment-register">
        <div className="register-toolbar">
          <div>
            <span className="eyebrow">Register</span>
            <h2>
              {assessments.length} assessment{assessments.length === 1 ? "" : "s"}
            </h2>
          </div>
          <label>
            <span>Filter state</span>
            <select
              className="field-control field-control--compact"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            >
              <option value="all">All states</option>
              <option value="draft">Draft</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        </div>
        {visible.length === 0 ? (
          <div className="empty-prompt">
            <strong>No assessments in this view.</strong>
            <p>Create an authorized draft or change the filter.</p>
          </div>
        ) : (
          <div className="assessment-table" role="table" aria-label="Assessments">
            <div className="assessment-row assessment-row--head" role="row">
              <span>Target</span>
              <span>Category</span>
              <span>State</span>
              <span>Next action</span>
            </div>
            {visible.map((assessment) => (
              <article className="assessment-row" role="row" key={assessment.id}>
                <div data-label="Target">
                  <strong>{assessment.target}</strong>
                  <small>
                    {assessment.status === "queued"
                      ? "Accepted by the local queue boundary. No runner execution is implied."
                      : assessment.status === "draft"
                        ? "Saved intent — review authorization before queueing."
                        : "Server-returned assessment state."}
                  </small>
                </div>
                <span data-label="Category">{assessment.targetCategory}</span>
                <span
                  data-label="State"
                  className={`state-label state-label--${assessment.status}`}
                >
                  <i aria-hidden="true" />
                  {assessment.status}
                </span>
                <div data-label="Next action">
                  {assessment.status === "draft" ? (
                    <button
                      className="button button--secondary button--inline"
                      type="button"
                      disabled={busy}
                      onClick={() => void onQueue(assessment.id)}
                    >
                      Review &amp; queue
                    </button>
                  ) : (
                    <span className="queue-reference">
                      {assessment.jobId ? `Job ${assessment.jobId.slice(0, 8)}` : "Server managed"}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <AssessmentWizard
        open={wizardOpen}
        busy={busy}
        onClose={() => setWizardOpen(false)}
        onCreate={onCreate}
      />
    </div>
  );
}
