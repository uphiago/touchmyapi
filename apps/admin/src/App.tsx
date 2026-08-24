import { useEffect, useState } from "react";
import type { AdminCapability, AdminSnapshot } from "@touchmyapi/contracts";
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

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function Operations({
  snapshot,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  onNavigate?: (view: AdminView) => void;
}) {
  const items = [
    ["API boundary", snapshot.operations.api],
    ["Database", snapshot.operations.database],
    ["Worker", snapshot.operations.worker],
    ["Queue depth", String(snapshot.operations.queueDepth)],
  ];
  return (
    <div className="operations-stack">
      <div className="metric-grid">
        {items.map(([label, value]) => (
          <article className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>server-returned safe metadata</small>
          </article>
        ))}
      </div>
      <section className="ops-layout">
        <article className="triage-card">
          <span className="eyebrow">Operational triage</span>
          <h2>{snapshot.operations.activeAlerts ? "Attention required" : "No active alert"}</h2>
          <p>
            {snapshot.operations.queueDepth} queued item
            {snapshot.operations.queueDepth === 1 ? "" : "s"} ·{" "}
            {formatAge(snapshot.operations.oldestJobAgeSeconds)} oldest queued item
          </p>
          <div className="triage-actions">
            <button type="button" onClick={() => onNavigate?.("queue")}>
              Review queue
            </button>
            <button type="button" className="secondary" onClick={() => onNavigate?.("audit")}>
              Open audit
            </button>
          </div>
        </article>
        <article className="boundary-card">
          <span className="eyebrow">Production gate</span>
          <h2>Identity before capability.</h2>
          <ol>
            <li>Separate staff OIDC + WebAuthn MFA</li>
            <li>Account-scoped reason, ticket and TTL</li>
            <li>Distinct approval before bounded queue action</li>
            <li>Append-only redacted staff audit</li>
          </ol>
        </article>
      </section>
    </div>
  );
}

function Accounts({
  snapshot,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  onNavigate?: (view: AdminView) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = snapshot.accounts.filter((account) =>
    `${account.displayName} ${account.accountId} ${account.plan} ${account.status}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="register">
      <div className="register-heading">
        <div>
          <span className="eyebrow">Tenant-safe directory</span>
          <h2>Safe account index</h2>
        </div>
        <label className="admin-search">
          <span>Search safe metadata</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name, plan, ID or status"
          />
        </label>
      </div>
      {visible.map((account) => (
        <article className="data-row" key={account.accountId}>
          <div>
            <strong>{account.displayName}</strong>
            <small>{shortId(account.accountId)}</small>
          </div>
          <span>{account.plan}</span>
          <span>{account.memberCount} member</span>
          <span className="status">● {account.status}</span>
          <button className="row-action" type="button" onClick={() => onNavigate?.("queue")}>
            Open queue view
          </button>
        </article>
      ))}
      {visible.length === 0 ? (
        <p className="boundary-note">No safe account metadata matches this search.</p>
      ) : null}
      <p className="boundary-note">
        No customer impersonation. No credentials, evidence, targets, or secrets are available here.
      </p>
    </section>
  );
}

function Queue({
  snapshot,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  onNavigate?: (view: AdminView) => void;
}) {
  return (
    <section className="register">
      <div className="register-heading">
        <div>
          <span className="eyebrow">Queue triage</span>
          <h2>Bounded operational metadata</h2>
        </div>
        <span className="queue-total">{snapshot.queue.length} visible</span>
      </div>
      {snapshot.queue.map((job) => (
        <article className="data-row" key={job.jobId}>
          <div>
            <strong>{job.targetLabel}</strong>
            <small>{shortId(job.jobId)}</small>
          </div>
          <span>{job.status}</span>
          <span>{shortId(job.accountId)}</span>
          <span>
            {formatAge(
              Math.max(0, Math.floor((Date.now() - new Date(job.enqueuedAt).getTime()) / 1000)),
            )}{" "}
            queued
          </span>
          <button className="row-action" type="button" onClick={() => onNavigate?.("access")}>
            Request bounded action
          </button>
        </article>
      ))}
      <p className="boundary-note">
        Never retries customer work directly from the browser. Actions require an active,
        account-scoped capability grant and execute through fixed server functions.
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
  const [accountId, setAccountId] = useState(snapshot.accounts[0]?.accountId ?? "");
  const [capability, setCapability] = useState<AdminCapability>("queue.requeue");
  const [jobId, setJobId] = useState(snapshot.queue[0]?.jobId ?? "");
  const [ticket, setTicket] = useState("OPS-1234");
  const [reason, setReason] = useState("Recover one reviewed local queue item");
  const [ttlSeconds, setTtlSeconds] = useState(900);
  const [message, setMessage] = useState(
    "A distinct mock approver is required before any bounded action.",
  );
  const runDemo = async () => {
    if (!accountId || !onRefresh || (capability !== "queue.reap" && !jobId)) return;
    setBusy(true);
    try {
      const grant = await requestGrant({
        accountId,
        capability,
        ticket,
        reason,
        ttlSeconds,
      });
      await approveGrant(grant.id);
      await performQueueAction({
        grantId: grant.id,
        accountId,
        capability,
        jobId: capability === "queue.reap" ? undefined : jobId,
      });
      await onRefresh();
      setMessage(`Approved grant used for one simulated ${capability}. Audit appended.`);
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
        <div className="grant-fields">
          <label>
            <span>Account</span>
            <select value={accountId} onChange={(event) => setAccountId(event.currentTarget.value)}>
              {snapshot.accounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Capability</span>
            <select
              value={capability}
              onChange={(event) => setCapability(event.currentTarget.value as AdminCapability)}
            >
              <option value="queue.requeue">queue.requeue</option>
              <option value="queue.cancel">queue.cancel</option>
              <option value="queue.reap">queue.reap</option>
            </select>
          </label>
          {capability !== "queue.reap" ? (
            <label>
              <span>Queue item</span>
              <select value={jobId} onChange={(event) => setJobId(event.currentTarget.value)}>
                {snapshot.queue
                  .filter((job) => job.accountId === accountId)
                  .map((job) => (
                    <option key={job.jobId} value={job.jobId}>
                      {job.targetLabel} · {shortId(job.jobId)}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>TTL</span>
            <select
              value={ttlSeconds}
              onChange={(event) => setTtlSeconds(Number(event.currentTarget.value))}
            >
              <option value={900}>15 minutes</option>
              <option value={1800}>30 minutes</option>
              <option value={3600}>60 minutes</option>
            </select>
          </label>
          <label>
            <span>Operational ticket</span>
            <input
              value={ticket}
              onChange={(event) => setTicket(event.currentTarget.value.toUpperCase())}
            />
          </label>
          <label className="wide">
            <span>Reason for access</span>
            <textarea value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
          </label>
        </div>
        <button
          disabled={
            busy ||
            !onRefresh ||
            reason.trim().length < 12 ||
            !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(ticket)
          }
          onClick={() => void runDemo()}
        >
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
          {activeView === "operations" && (
            <Operations snapshot={snapshot} onNavigate={onNavigate} />
          )}{" "}
          {activeView === "accounts" && <Accounts snapshot={snapshot} onNavigate={onNavigate} />}{" "}
          {activeView === "queue" && <Queue snapshot={snapshot} onNavigate={onNavigate} />}{" "}
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
