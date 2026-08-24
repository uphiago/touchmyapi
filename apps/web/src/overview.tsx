import type { AccountSummary, Assessment } from "../../../packages/contracts/src";

export type OverviewProps = Readonly<{
  activeAccount: AccountSummary;
  assessments: readonly Assessment[];
  memberCount: number;
  onNewAssessment: () => void;
}>;

const activeStates = new Set(["queued", "running", "analyzing"]);

export function Overview({
  activeAccount,
  assessments,
  memberCount,
  onNewAssessment,
}: OverviewProps) {
  const active = assessments.filter((assessment) => activeStates.has(assessment.status)).length;
  const drafts = assessments.filter((assessment) => assessment.status === "draft").length;
  return (
    <div className="view-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">Operational workspace</span>
          <h1>Know what is authorized, queued, and next.</h1>
          <p>
            The server owns account, policy, and queue decisions. This console turns those decisions
            into a clear operator workflow.
          </p>
        </div>
        <button
          className="button button--primary button--inline"
          type="button"
          onClick={onNewAssessment}
        >
          <span aria-hidden="true">＋</span> New assessment
        </button>
      </section>
      <section className="metric-grid" aria-label="Workspace summary">
        <article className="metric">
          <span>Total assessments</span>
          <strong>{String(assessments.length).padStart(2, "0")}</strong>
          <small>Visible in this account</small>
        </article>
        <article className="metric">
          <span>In queue or progress</span>
          <strong>{String(active).padStart(2, "0")}</strong>
          <small>Server-returned state</small>
        </article>
        <article className="metric">
          <span>Drafts to review</span>
          <strong>{String(drafts).padStart(2, "0")}</strong>
          <small>Not scheduled</small>
        </article>
        <article className="metric">
          <span>Workspace members</span>
          <strong>{String(memberCount).padStart(2, "0")}</strong>
          <small>{activeAccount.role} access</small>
        </article>
      </section>
      <section className="operations-grid">
        <article className="section-block section-block--wide">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Recent activity</span>
              <h2>Assessment state</h2>
            </div>
            <span className="section-count">{assessments.length}</span>
          </div>
          {assessments.length === 0 ? (
            <div className="empty-prompt">
              <strong>No assessment drafts yet.</strong>
              <p>Start with a target you are explicitly authorized to assess.</p>
            </div>
          ) : (
            <ol className="activity-list">
              {assessments.slice(0, 5).map((assessment) => (
                <li key={assessment.id}>
                  <span
                    className={`state-mark state-mark--${assessment.status}`}
                    aria-hidden="true"
                  />
                  <div>
                    <strong>{assessment.target}</strong>
                    <span>
                      {assessment.targetCategory} · {assessment.status}
                    </span>
                  </div>
                  <time>{new Date(assessment.updatedAt).toLocaleDateString("en-US")}</time>
                </li>
              ))}
            </ol>
          )}
        </article>
        <aside className="section-block authorization-note">
          <span className="eyebrow">Authorization boundary</span>
          <h2>Intent is not execution.</h2>
          <p>
            Saving a draft records operator intent. Queueing accepts work at the server boundary;
            execution still requires verification, policy, entitlement, and a current fenced worker.
          </p>
          <dl>
            <div>
              <dt>Workspace</dt>
              <dd>{activeAccount.accountId.slice(0, 8)}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{activeAccount.role}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{activeAccount.status}</dd>
            </div>
          </dl>
        </aside>
      </section>
    </div>
  );
}
