import type { AuthProvider } from "@touchmyapi/contracts";
import type { ApiStatus } from "./app-shell";

export type LandingPageProps = Readonly<{
  status: ApiStatus;
  providers: readonly AuthProvider[];
  busy: boolean;
  error: string | null;
  onGitHub: () => void;
  onRetry: () => void | Promise<void>;
}>;

const workflow = [
  ["01", "Authorization recorded", "Target, scope and versioned terms become durable facts."],
  ["02", "Policy decides", "Membership, plan, scope and limits are reduced server-side."],
  ["03", "PostgreSQL queues", "Durable jobs, leases and fencing keep execution accountable."],
] as const;

export function LandingPage({
  status,
  providers,
  busy,
  error,
  onGitHub,
  onRetry,
}: LandingPageProps) {
  const githubReady = providers.some((provider) => provider.id === "github");
  const statusLabel =
    status === "checking" ? "Checking API" : status === "online" ? "API online" : "API unavailable";

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="brand-lockup brand-lockup--public" href="/" aria-label="TouchMyAPI home">
          <span className="brand-mark" aria-hidden="true">
            T/
          </span>
          <div>
            <strong>TouchMyAPI</strong>
            <span>Authorized security operations</span>
          </div>
        </a>
        <div className={`api-indicator api-indicator--${status}`} aria-label={statusLabel}>
          <span aria-hidden="true" />
          {statusLabel}
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero__copy">
            <span className="eyebrow">Security assessment control plane</span>
            <h1>Security work should start with proof, not a scan.</h1>
            <p>
              Define an authorized boundary, let policy reduce what is allowed, and follow every
              assessment through a durable operational timeline.
            </p>
            <div className="landing-actions">
              {githubReady ? (
                <button
                  className="button button--primary landing-login"
                  type="button"
                  disabled={busy || status !== "online"}
                  onClick={onGitHub}
                >
                  <span className="github-glyph" aria-hidden="true">
                    GH
                  </span>
                  Continue with GitHub
                </button>
              ) : (
                <div className="provider-pending" role="status">
                  <strong>
                    {status === "online"
                      ? "GitHub sign-in is not configured yet."
                      : "The authentication API is currently unavailable."}
                  </strong>
                  <span>
                    {status === "online"
                      ? "The site is online; an OAuth App must be connected before sign-in."
                      : "No login attempt was made. Retry when the service boundary is healthy."}
                  </span>
                </div>
              )}
              {error ? (
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => void onRetry()}
                >
                  Retry connection
                </button>
              ) : null}
            </div>
            <p className="landing-consent">
              Sign-in creates a private workspace. It never authorizes a target automatically.
            </p>
          </div>
          <aside className="landing-manifest" aria-label="Operational boundaries">
            <div className="manifest-head">
              <span>CONTROL MANIFEST / V1</span>
              <i>DEFAULT DENY</i>
            </div>
            <dl>
              <div>
                <dt>Identity</dt>
                <dd>Immutable provider subject</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>Server-selected membership</dd>
              </div>
              <div>
                <dt>Execution</dt>
                <dd>Least-privilege fenced runner</dd>
              </div>
              <div>
                <dt>Billing</dt>
                <dd>Webhook authority only</dd>
              </div>
            </dl>
            <div className="manifest-stamp">
              <span>AI</span>
              <strong>AI never executes</strong>
              <small>Planning and analysis stay behind policy.</small>
            </div>
          </aside>
        </section>

        <section className="landing-workflow" aria-labelledby="workflow-title">
          <div>
            <span className="eyebrow">How work enters the system</span>
            <h2 id="workflow-title">An explicit chain of custody.</h2>
          </div>
          <ol>
            {workflow.map(([index, title, copy]) => (
              <li key={index}>
                <span>{index}</span>
                <strong>{title}</strong>
                <p>{copy}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="landing-footer">
        <span>TouchMyAPI / authorized assessments only</span>
        <span>No autonomous execution · no public evidence buckets</span>
      </footer>
    </div>
  );
}
