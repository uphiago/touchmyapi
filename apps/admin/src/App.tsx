import { useEffect, useState } from "react";
import type { AdminSnapshot } from "@touchmyapi/contracts";
import {
  approveGrant,
  bootstrapAdmin,
  loadAdminSnapshot,
  performQueueAction,
  requestGrant,
} from "./api-client";

export type AdminView = "operations" | "accounts" | "queue" | "access" | "billing" | "audit";
const views: readonly { id: AdminView; label: string }[] = [
  { id: "operations", label: "Operations" },
  { id: "accounts", label: "Accounts" },
  { id: "queue", label: "Queue" },
  { id: "access", label: "Access grants" },
  { id: "billing", label: "Billing" },
  { id: "audit", label: "Audit" },
];

const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;

function Operations({ snapshot }: { snapshot: AdminSnapshot }) {
  const items = [
    ["API boundary", snapshot.operations.api],
    ["Database", snapshot.operations.database],
    ["Worker", snapshot.operations.worker],
    ["Queue depth", String(snapshot.operations.queueDepth)],
  ];
  return (
    <div className="metric-grid">
      {items.map(([label, value]) => (
        <article className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>server-returned safe metadata</small>
        </article>
      ))}
    </div>
  );
}

function Accounts({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="register">
      <h2>Safe account index</h2>
      {snapshot.accounts.map((account) => (
        <article className="data-row" key={account.accountId}>
          <div>
            <strong>{account.displayName}</strong>
            <small>{shortId(account.accountId)}</small>
          </div>
          <span>{account.plan}</span>
          <span>{account.memberCount} member</span>
          <span className="status">● {account.status}</span>
        </article>
      ))}
      <p className="boundary-note">
        No customer impersonation. No credentials, evidence, targets, or secrets are available here.
      </p>
    </section>
  );
}

function Queue({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="register">
      <h2>Queue metadata</h2>
      {snapshot.queue.map((job) => (
        <article className="data-row" key={job.jobId}>
          <div>
            <strong>{job.targetLabel}</strong>
            <small>{shortId(job.jobId)}</small>
          </div>
          <span>{job.status}</span>
          <span>{shortId(job.accountId)}</span>
          <span>grant required</span>
        </article>
      ))}
      <p className="boundary-note">
        Actions are unavailable until an account-scoped capability grant is active.
      </p>
    </section>
  );
}

function Access({
  snapshot,
  onRefresh,
}: {
  snapshot: AdminSnapshot;
  onRefresh?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "A distinct mock approver is required before any bounded action.",
  );
  const runDemo = async () => {
    const account = snapshot.accounts[0];
    const job = snapshot.queue[0];
    if (!account || !job || !onRefresh) return;
    setBusy(true);
    try {
      const grant = await requestGrant({
        accountId: account.accountId,
        capability: "queue.requeue",
        ticket: "OPS-1234",
        reason: "Recover one reviewed local queue item",
        ttlSeconds: 900,
      });
      await approveGrant(grant.id);
      await performQueueAction({
        grantId: grant.id,
        accountId: account.accountId,
        capability: "queue.requeue",
        jobId: job.jobId,
      });
      await onRefresh();
      setMessage("Approved grant used for one simulated requeue. Audit appended.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Grant workflow failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grant-layout">
      <article className="grant-form">
        <span className="eyebrow">JIT demonstration</span>
        <h2>Request capability grant</h2>
        <p>{message}</p>
        <dl>
          <div>
            <dt>Account</dt>
            <dd>{snapshot.accounts[0]?.displayName ?? "none"}</dd>
          </div>
          <div>
            <dt>Capability</dt>
            <dd>queue.requeue</dd>
          </div>
          <div>
            <dt>TTL</dt>
            <dd>15 minutes</dd>
          </div>
          <div>
            <dt>Ticket</dt>
            <dd>OPS-1234</dd>
          </div>
        </dl>
        <button disabled={busy || !onRefresh} onClick={() => void runDemo()}>
          {busy ? "Running approval flow…" : "Request → approve → simulate"}
        </button>
      </article>
      <article className="grant-list">
        <span className="eyebrow">Recent grants</span>
        <h2>
          {snapshot.grants.length || "No"} grant{snapshot.grants.length === 1 ? "" : "s"}
        </h2>
        {snapshot.grants.map((grant) => (
          <div className="grant-item" key={grant.id}>
            <strong>{grant.capability}</strong>
            <span>{grant.status}</span>
            <small>expires {new Date(grant.expiresAt).toLocaleTimeString()}</small>
          </div>
        ))}
      </article>
    </section>
  );
}

function Billing({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="empty-panel">
      <span className="eyebrow">Webhook authority</span>
      <h2>Read-only billing</h2>
      <p>
        Entitlements change only from verified webhook processing. This surface cannot mutate plans,
        credits, or invoices.
      </p>
      <strong>{snapshot.billing.webhookStatus}</strong>
    </section>
  );
}
function Audit({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="register">
      <h2>Redacted staff timeline</h2>
      {snapshot.audit.length === 0 ? (
        <p className="boundary-note">No staff action recorded in this process.</p>
      ) : (
        snapshot.audit.map((event) => (
          <article className="audit-row" key={event.id}>
            <span>{event.occurredAt.slice(11, 19)}</span>
            <strong>{event.action}</strong>
            <p>{event.summary}</p>
            <code>{shortId(event.requestId)}</code>
          </article>
        ))
      )}
    </section>
  );
}

export function AdminConsole({
  snapshot,
  activeView,
  onNavigate,
  onRefresh,
}: {
  snapshot: AdminSnapshot;
  activeView: AdminView;
  onNavigate?: (view: AdminView) => void;
  onRefresh?: () => Promise<void>;
}) {
  return (
    <div className="admin-shell">
      <aside>
        <div className="brand">
          <span>T∕</span>
          <div>
            <strong>TouchMyAPI</strong>
            <small>STAFF CONTROL PLANE</small>
          </div>
        </div>
        <nav>
          {views.map((view, index) => (
            <button
              className={activeView === view.id ? "active" : ""}
              key={view.id}
              onClick={() => onNavigate?.(view.id)}
            >
              <i>0{index + 1}</i>
              {view.label}
            </button>
          ))}
        </nav>
        <div className="rail-warning">
          <span>HARD BOUNDARY</span>
          <p>
            No customer impersonation
            <br />
            No arbitrary SQL
            <br />
            No raw evidence
          </p>
        </div>
      </aside>
      <main>
        <div className="mock-banner">
          <strong>LOCAL STAFF SIMULATION</strong>
          <span>State resets with the admin API process. No real queue action executes.</span>
        </div>
        <header>
          <div>
            <span className="eyebrow">SEPARATE ADMIN ORIGIN</span>
            <h1>{views.find((view) => view.id === activeView)?.label}</h1>
          </div>
          <div className="identity">
            <span className="status">● session active</span>
            <small>{snapshot.session.email}</small>
          </div>
        </header>
        <div className="content">
          {activeView === "operations" && <Operations snapshot={snapshot} />}{" "}
          {activeView === "accounts" && <Accounts snapshot={snapshot} />}{" "}
          {activeView === "queue" && <Queue snapshot={snapshot} />}{" "}
          {activeView === "access" && <Access snapshot={snapshot} onRefresh={onRefresh} />}{" "}
          {activeView === "billing" && <Billing snapshot={snapshot} />}{" "}
          {activeView === "audit" && <Audit snapshot={snapshot} />}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [activeView, setActiveView] = useState<AdminView>("operations");
  const [error, setError] = useState<string>();
  const refresh = async () => {
    const next = await loadAdminSnapshot();
    setSnapshot(next);
    setError(undefined);
  };
  useEffect(() => {
    void bootstrapAdmin()
      .then(setSnapshot)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Admin API unavailable"));
  }, []);
  if (!snapshot)
    return (
      <div className="boot">
        <div className="brand">
          <span>T∕</span>
          <div>
            <strong>TouchMyAPI</strong>
            <small>STAFF CONTROL PLANE</small>
          </div>
        </div>
        <p>{error ?? "Establishing isolated staff session…"}</p>
        {error && <button onClick={() => window.location.reload()}>Retry</button>}
      </div>
    );
  return (
    <AdminConsole
      snapshot={snapshot}
      activeView={activeView}
      onNavigate={setActiveView}
      onRefresh={refresh}
    />
  );
}
