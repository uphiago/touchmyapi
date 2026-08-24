import type {
  Assessment,
  AssessmentDeliveryResponse,
  Notification,
  ReportMetadata,
} from "../../../packages/contracts/src";

export type ResultsWorkspaceProps = Readonly<{
  assessments: readonly Assessment[];
  selectedAssessmentId?: string;
  delivery?: AssessmentDeliveryResponse;
  notifications: readonly Notification[];
  reports: readonly ReportMetadata[];
  plan: string;
  busy: boolean;
  onSelect: (assessmentId: string) => void;
  onRefresh: () => void | Promise<void>;
  onMarkRead: (notificationId: string) => void | Promise<void>;
  onDownload: (reportId: string) => void | Promise<void>;
}>;

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function titleCase(value: string): string {
  return label(value).replace(/(^|\s)\S/gu, (character) => character.toUpperCase());
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function findingCount(total: number): string {
  return `${total} finding${total === 1 ? "" : "s"}`;
}

function DeliveryDetail({ delivery }: { delivery?: AssessmentDeliveryResponse }) {
  if (!delivery) {
    return (
      <div className="results-empty" role="status">
        <strong>Select an assessment to load its server-filtered delivery.</strong>
        <p>Results are fetched only for the active account and never inferred in the browser.</p>
      </div>
    );
  }

  return (
    <div className="delivery-detail">
      <div className="delivery-detail__header">
        <div>
          <span className="eyebrow">Server-filtered result</span>
          <h2>{titleCase(delivery.visibility)} delivery</h2>
          <p>
            {findingCount(delivery.summary.total)} · Assessment status: {label(delivery.status)}
          </p>
        </div>
        <span className={`visibility-pill visibility-pill--${delivery.visibility}`}>
          {delivery.visibility}
        </span>
      </div>
      {["queued", "running", "analyzing"].includes(delivery.status) ? (
        <div className="upgrade-callout" role="status">
          <span className="eyebrow">Processing boundary</span>
          <strong>Processing is not active in this environment yet.</strong>
          <p>
            The queue accepted the authorized request, but the isolated production runner is not
            enabled. This assessment remains queued and no target contact is claimed.
          </p>
        </div>
      ) : null}
      <div className="finding-summary" aria-label="Finding summary">
        <div>
          <span>Total</span>
          <strong>{delivery.summary.total}</strong>
        </div>
        {Object.entries(delivery.summary.bySeverity).map(([severity, count]) => (
          <div key={severity}>
            <span>{severity}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      {delivery.visibility === "aggregate" ? (
        <div className="upgrade-callout">
          <span className="eyebrow">Aggregate only</span>
          <strong>Finding detail is reserved for an eligible plan.</strong>
          <p>
            This account can see counts and severity totals. Titles, evidence, reproduction, and
            remediation are intentionally withheld by the server.
          </p>
        </div>
      ) : delivery.findings.length === 0 ? (
        <div className="results-empty">
          <strong>No findings were returned.</strong>
          <p>
            The server returned a valid {delivery.visibility} delivery with an empty finding set.
          </p>
        </div>
      ) : delivery.visibility === "masked" ? (
        <div className="finding-list" aria-label="masked findings">
          {delivery.findings.map((finding) => (
            <article className="finding-card" key={finding.id}>
              <div className="finding-card__heading">
                <div>
                  <span className={`severity severity--${finding.severity}`}>
                    {finding.severity}
                  </span>
                  <h3>{finding.title}</h3>
                </div>
                <span className="finding-category">{finding.category}</span>
              </div>
              <p className="finding-card__hint">
                Masked delivery: evidence and reproduction remain protected.
              </p>
            </article>
          ))}
        </div>
      ) : (
        <div className="finding-list" aria-label="detailed findings">
          {delivery.findings.map((finding) => (
            <article className="finding-card" key={finding.id}>
              <div className="finding-card__heading">
                <div>
                  <span className={`severity severity--${finding.severity}`}>
                    {finding.severity}
                  </span>
                  <h3>{finding.title}</h3>
                </div>
                <span className="finding-category">{finding.category}</span>
              </div>
              <dl className="finding-detail-grid">
                {finding.endpoint ? (
                  <div>
                    <dt>Endpoint</dt>
                    <dd>{finding.endpoint}</dd>
                  </div>
                ) : null}
                {finding.impact ? (
                  <div>
                    <dt>Impact</dt>
                    <dd>{finding.impact}</dd>
                  </div>
                ) : null}
                {finding.remediation ? (
                  <div>
                    <dt>Remediation</dt>
                    <dd>{finding.remediation}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Reproduction</dt>
                  <dd>{finding.reproduction.length} approved step(s)</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications({
  notifications,
  busy,
  onMarkRead,
}: Pick<ResultsWorkspaceProps, "notifications" | "busy" | "onMarkRead">) {
  const unreadCount = notifications.filter((notification) => notification.readAt === null).length;
  return (
    <section className="section-block notifications-panel" aria-labelledby="notifications-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Signal</span>
          <h2 id="notifications-title">Notifications</h2>
        </div>
        <span className="section-count">{unreadCount} unread</span>
      </div>
      {notifications.length === 0 ? (
        <p className="section-copy">No assessment notifications for this workspace.</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((notification) => {
            const unread = notification.readAt === null;
            return (
              <li
                className={unread ? "notification notification--unread" : "notification"}
                key={notification.id}
              >
                <span className="notification-dot" aria-hidden="true" />
                <div>
                  <strong>
                    {notification.kind === "assessment_completed"
                      ? "Assessment completed"
                      : "Assessment failed"}
                  </strong>
                  <span>{formatDate(notification.createdAt)}</span>
                </div>
                {unread ? (
                  <button
                    className="button button--ghost button--inline"
                    type="button"
                    disabled={busy}
                    onClick={() => void onMarkRead(notification.id)}
                  >
                    Mark read
                  </button>
                ) : (
                  <span className="read-label">Read</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Reports({
  reports,
  plan,
  busy,
  onDownload,
}: Pick<ResultsWorkspaceProps, "reports" | "plan" | "busy" | "onDownload">) {
  const allowed = plan === "pro" || plan === "lifetime";
  return (
    <section className="section-block reports-panel" aria-labelledby="reports-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Export history</span>
          <h2 id="reports-title">Reports</h2>
        </div>
        <span className="section-count">{reports.length}</span>
      </div>
      {!allowed ? (
        <div className="upgrade-callout upgrade-callout--compact">
          <strong>Reports require an upgrade.</strong>
          <p>Technical, executive, and JSON exports are available on an eligible plan.</p>
          <span className="access-mode">Current plan: {label(plan)}</span>
        </div>
      ) : reports.length === 0 ? (
        <p className="section-copy">No reports generated for this assessment yet.</p>
      ) : (
        <ul className="report-list">
          {reports.map((report) => (
            <li key={report.id}>
              <div>
                <strong>
                  {report.kind === "pdf_technical"
                    ? "Technical PDF"
                    : report.kind === "pdf_executive"
                      ? "Executive PDF"
                      : "JSON export"}
                </strong>
                <span>
                  {report.contractVersion} · {formatDate(report.generatedAt)}
                </span>
              </div>
              <button
                className="button button--ghost button--inline"
                type="button"
                disabled={busy}
                onClick={() => void onDownload(report.id)}
              >
                Download
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResultsWorkspace({
  assessments,
  selectedAssessmentId,
  delivery,
  notifications,
  reports,
  plan,
  busy,
  onSelect,
  onRefresh,
  onMarkRead,
  onDownload,
}: ResultsWorkspaceProps) {
  const selected = assessments.find((assessment) => assessment.id === selectedAssessmentId);
  return (
    <div className="results-workspace">
      <section className="page-intro page-intro--compact">
        <div>
          <span className="eyebrow">Results desk</span>
          <h1>Follow state. Read only what the plan permits.</h1>
          <p>
            Refreshes are safe to repeat; every result and report remains scoped to this account.
          </p>
        </div>
        <button
          className="button button--secondary button--inline"
          type="button"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          {busy ? "Refreshing…" : "↻ Refresh results"}
        </button>
      </section>
      <div className="results-layout">
        <section
          className="section-block assessment-selector"
          aria-labelledby="assessment-selector-title"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">Assessment history</span>
              <h2 id="assessment-selector-title">Select a result</h2>
            </div>
            <span className="section-count">{assessments.length}</span>
          </div>
          {assessments.length === 0 ? (
            <div className="results-empty">
              <strong>No assessments yet.</strong>
              <p>Completed results will appear here.</p>
            </div>
          ) : (
            <div className="assessment-selector__list">
              {assessments.map((assessment) => (
                <button
                  className={`assessment-selector__item${assessment.id === selectedAssessmentId ? " assessment-selector__item--active" : ""}`}
                  type="button"
                  key={assessment.id}
                  aria-pressed={assessment.id === selectedAssessmentId}
                  onClick={() => onSelect(assessment.id)}
                >
                  <span>
                    <strong>{assessment.target}</strong>
                    <small>
                      {assessment.targetCategory} · {label(assessment.status)}
                    </small>
                  </span>
                  <time dateTime={assessment.updatedAt}>{formatDate(assessment.updatedAt)}</time>
                </button>
              ))}
            </div>
          )}
        </section>
        <section
          className="section-block result-detail-panel"
          aria-labelledby="result-detail-title"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">Selected assessment</span>
              <h2 id="result-detail-title">{selected?.target ?? "No selection"}</h2>
            </div>
            {selected ? (
              <span className={`state-label state-label--${selected.status}`}>
                <i aria-hidden="true" />
                {selected.status}
              </span>
            ) : null}
          </div>
          <DeliveryDetail delivery={delivery} />
        </section>
      </div>
      <div className="results-support-grid">
        <Notifications notifications={notifications} busy={busy} onMarkRead={onMarkRead} />
        <Reports reports={reports} plan={plan} busy={busy} onDownload={onDownload} />
      </div>
    </div>
  );
}
