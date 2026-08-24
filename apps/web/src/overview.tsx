import type { AccountSummary, Assessment } from "../../../packages/contracts/src";

export type OverviewProps = Readonly<{
  activeAccount: AccountSummary;
  plan: string;
  assessments: readonly Assessment[];
  memberCount: number;
  canCreate?: boolean;
  onNewAssessment: () => void;
}>;

const activeStates = new Set(["queued", "running", "analyzing"]);

const roleGuidance: Record<
  AccountSummary["role"],
  { title: string; next: string; guardrail: string }
> = {
  owner: {
    title: "Your owner workflow",
    next: "Confirm team access, create the first authorized assessment, then review delivery access.",
    guardrail: "Owner changes are protected by the last-owner transaction rule.",
  },
  admin: {
    title: "Your admin workflow",
    next: "Manage collaborators and keep assessment operations moving inside the approved scope.",
    guardrail: "Billing entitlements and staff operations remain outside this role.",
  },
  operator: {
    title: "Your operator workflow",
    next: "Create authorized drafts, perform the final queue review, and follow server state.",
    guardrail: "Team access, billing, policy and queue internals remain server controlled.",
  },
  viewer: {
    title: "Your viewer workflow",
    next: "Follow assessment state and consume only the delivery returned for this plan.",
    guardrail: "This role cannot create, queue, invite, or change workspace access.",
  },
  billing: {
    title: "Your billing workflow",
    next: "Review the current plan and payment state without accessing assessment data.",
    guardrail: "Only verified Stripe webhooks can change entitlements.",
  },
};

export function Overview({
  activeAccount,
  plan,
  assessments,
  memberCount,
  canCreate = true,
  onNewAssessment,
}: OverviewProps) {
  const active = assessments.filter((assessment) => activeStates.has(assessment.status)).length;
  const drafts = assessments.filter((assessment) => assessment.status === "draft").length;
  const guidance = roleGuidance[activeAccount.role];
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
        {canCreate ? (
          <button
            className="button button--primary button--inline"
            type="button"
            onClick={onNewAssessment}
          >
            <span aria-hidden="true">＋</span> New assessment
          </button>
        ) : (
          <span className="access-mode">Read-only access</span>
        )}
      </section>
      <section className="journey-card" aria-label={`${activeAccount.role} workflow`}>
        <div>
          <span className="eyebrow">Role-aware next step</span>
          <h2>{guidance.title}</h2>
          <p>{guidance.next}</p>
        </div>
        <dl>
          <div>
            <dt>Plan</dt>
            <dd>{plan.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>Delivery is plan-filtered by the server</dd>
          </div>
        </dl>
        <small>{guidance.guardrail}</small>
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
