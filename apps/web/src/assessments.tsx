import { useMemo, useState } from "react";
import type { Assessment, AssessmentCreate } from "../../../packages/contracts/src";
import { AssessmentWizard } from "./assessment-wizard";

export type AssessmentsProps = Readonly<{
  assessments: readonly Assessment[];
  busy: boolean;
  plan?: string;
  canCreate?: boolean;
  canQueue?: boolean;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
  onQueue: (assessmentId: string) => void | Promise<void>;
}>;

function DeliveryAccess({ plan }: { plan: string }) {
  const access =
    plan === "pro" || plan === "lifetime"
      ? [
          "Validated findings with evidence, impact and remediation",
          "Technical + executive PDF",
          "Versioned JSON export",
          "Comparable assessment history",
        ]
      : plan === "free_verified" || plan === "verified"
        ? ["Finding title, category and severity", "Evidence and reproduction remain blocked"]
        : ["Passive posture summary", "No active testing, evidence or reproduction detail"];

  return (
    <section className="delivery-access" aria-label="Assessment delivery access">
      <div>
        <span className="eyebrow">What this account receives</span>
        <h2>{plan.replaceAll("_", " ")} delivery</h2>
        <p>
          The server filters every delivery. Browser state never unlocks findings, evidence or
          reports.
        </p>
      </div>
      <ul>
        {access.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function QueueReview({
  assessment,
  busy,
  onCancel,
  onConfirm,
}: Readonly<{
  assessment: Assessment;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}>) {
  return (
    <dialog className="queue-review" open aria-labelledby="queue-review-title">
      <header>
        <div>
          <span className="eyebrow">Final queue review</span>
          <h2 id="queue-review-title">Send one bounded job to PostgreSQL.</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close review">
          ×
        </button>
      </header>
      <dl>
        <div>
          <dt>Target</dt>
          <dd>{assessment.target}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{assessment.scope.length ? assessment.scope.join(", ") : assessment.target}</dd>
        </div>
        <div>
          <dt>Playbook</dt>
          <dd>Passive public posture · {assessment.playbookVersion}</dd>
        </div>
        <div>
          <dt>Authorization</dt>
          <dd>terms@1 recorded with this draft</dd>
        </div>
      </dl>
      <div className="queue-review__boundary">
        <strong>What happens next</strong>
        <p>
          Policy revalidates scope and resolved addresses. If allowed, one durable queued job and a
          redacted outbox event are created. A queue receipt is not a completion result.
        </p>
      </div>
      <footer>
        <button className="button button--ghost" type="button" disabled={busy} onClick={onCancel}>
          Back to draft
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={busy}
          onClick={() => void onConfirm()}
        >
          {busy ? "Policy check…" : "Confirm & queue"}
        </button>
      </footer>
    </dialog>
  );
}

export function Assessments({
  assessments,
  busy,
  plan = "free_unverified",
  canCreate = true,
  canQueue = true,
  onCreate,
  onQueue,
}: AssessmentsProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [queueCandidate, setQueueCandidate] = useState<Assessment>();
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
        {canCreate ? (
          <button
            className="button button--primary button--inline"
            type="button"
            onClick={() => setWizardOpen(true)}
          >
            ＋ New assessment
          </button>
        ) : (
          <span className="access-mode">Read-only access</span>
        )}
      </section>
      <DeliveryAccess plan={plan} />
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
                  {assessment.status === "draft" && canQueue ? (
                    <button
                      className="button button--secondary button--inline"
                      type="button"
                      disabled={busy}
                      onClick={() => setQueueCandidate(assessment)}
                    >
                      Review &amp; queue
                    </button>
                  ) : (
                    <span className="queue-reference">
                      {assessment.status === "draft"
                        ? "Operator action required"
                        : assessment.jobId
                          ? `Job ${assessment.jobId.slice(0, 8)}`
                          : "Server managed"}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {canCreate ? (
        <AssessmentWizard
          open={wizardOpen}
          busy={busy}
          onClose={() => setWizardOpen(false)}
          onCreate={onCreate}
        />
      ) : null}
      {queueCandidate ? (
        <QueueReview
          assessment={queueCandidate}
          busy={busy}
          onCancel={() => setQueueCandidate(undefined)}
          onConfirm={async () => {
            await onQueue(queueCandidate.id);
            setQueueCandidate(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
