import { useEffect, useMemo, useState } from "react";
import {
  healthResponseSchema,
  type AccountSummary,
  type Assessment,
  type AssessmentCreate,
  type InvitationCreate,
  type Membership,
} from "../../../packages/contracts/src";
import { ApiClientError, createApiClient } from "../../../packages/ui/api-client";
import { AccountSwitcher } from "./account-switcher";
import { AppShell, type ApiStatus, type CustomerView } from "./app-shell";
import { Assessments } from "./assessments";
import { Memberships } from "./memberships";
import { Overview } from "./overview";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";
const LOCAL_MOCKS = import.meta.env.VITE_LOCAL_MOCKS === "1";

export type CustomerConsoleProps = Readonly<{
  status: ApiStatus;
  localMocks: boolean;
  activeView: CustomerView;
  accounts: readonly AccountSummary[];
  memberships: readonly Membership[];
  assessments: readonly Assessment[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onNavigate: (view: CustomerView) => void;
  onRetry: () => void | Promise<void>;
  onSwitch: (accountId: string) => void | Promise<void>;
  onInvite: (input: InvitationCreate) => void | Promise<void>;
  onAccept: (token: string) => void | Promise<void>;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
  onQueue: (assessmentId: string) => void | Promise<void>;
}>;

export function CustomerConsole({
  status,
  localMocks,
  activeView,
  accounts,
  memberships,
  assessments,
  busy,
  error,
  notice,
  onNavigate,
  onRetry,
  onSwitch,
  onInvite,
  onAccept,
  onCreate,
  onQueue,
}: CustomerConsoleProps) {
  const activeAccount = accounts.find((account) => account.active) ?? accounts[0];
  let content: React.ReactNode;

  if (!activeAccount) {
    content = (
      <section className="session-empty">
        <span className="eyebrow">Workspace session</span>
        <h1>Your API is reachable. Your workspace is not.</h1>
        <p>{error ?? "Sign in to load the accounts and roles selected by the server."}</p>
        <button
          className="button button--secondary button--inline"
          type="button"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          Retry workspace
        </button>
      </section>
    );
  } else if (activeView === "overview") {
    content = (
      <Overview
        activeAccount={activeAccount}
        assessments={assessments}
        memberCount={memberships.length}
        onNewAssessment={() => onNavigate("assessments")}
      />
    );
  } else if (activeView === "assessments") {
    content = (
      <Assessments assessments={assessments} busy={busy} onCreate={onCreate} onQueue={onQueue} />
    );
  } else if (activeView === "team") {
    content = (
      <div className="view-stack">
        <section className="page-intro page-intro--compact">
          <div>
            <span className="eyebrow">Access control</span>
            <h1>People, roles, and explicit invitations.</h1>
            <p>Email is delivery data. Membership begins only after authenticated acceptance.</p>
          </div>
        </section>
        <Memberships
          accountId={activeAccount.accountId}
          memberships={memberships}
          busy={busy}
          onInvite={onInvite}
          onAccept={onAccept}
        />
      </div>
    );
  } else {
    content = (
      <div className="view-stack">
        <section className="page-intro page-intro--compact">
          <div>
            <span className="eyebrow">Workspace control</span>
            <h1>One server-selected account per session.</h1>
            <p>Switching validates membership and rotates the active account server-side.</p>
          </div>
        </section>
        <div className="workspace-settings">
          <AccountSwitcher accounts={accounts} busy={busy} onSwitch={onSwitch} />
          <section className="section-block">
            <span className="eyebrow">Session boundary</span>
            <h2>Browser state is display-only.</h2>
            <p className="section-copy">
              Account IDs in URLs or controls never grant access. Every request is resolved against
              the active server session and membership.
            </p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <AppShell
      status={status}
      localMocks={localMocks}
      activeView={activeView}
      activeAccount={activeAccount}
      onNavigate={onNavigate}
    >
      {activeAccount && (error || notice) ? (
        <div className={`flash-message${error ? " flash-message--error" : ""}`} role="status">
          <span>{error ?? notice}</span>
          {error ? (
            <button type="button" onClick={() => void onRetry()}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {content}
    </AppShell>
  );
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [activeView, setActiveView] = useState<CustomerView>("overview");
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  const [memberships, setMemberships] = useState<readonly Membership[]>([]);
  const [assessments, setAssessments] = useState<readonly Assessment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const client = useMemo(() => createApiClient(API_BASE_URL), []);
  const activeAccount = accounts.find((account) => account.active) ?? accounts[0];

  async function refreshWorkspace(cancelled?: () => boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const snapshot = await client.listAccounts();
      if (cancelled?.()) return;
      setAccounts(snapshot.accounts);
      const active = snapshot.accounts.find((account) => account.active) ?? snapshot.accounts[0];
      if (!active) return;
      const [membershipSnapshot, assessmentSnapshot] = await Promise.all([
        client.listMemberships(active.accountId),
        client.listAssessments(active.accountId),
      ]);
      if (cancelled?.()) return;
      setMemberships(membershipSnapshot.memberships);
      setAssessments(assessmentSnapshot.assessments);
    } catch (cause) {
      if (!cancelled?.())
        setError(cause instanceof ApiClientError ? cause.message : "Workspace unavailable");
    } finally {
      if (!cancelled?.()) setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`);
        const parsed = response.ok
          ? healthResponseSchema.safeParse(await response.json())
          : { success: false };
        if (!cancelled) setStatus(parsed.success ? "online" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    void (async () => {
      if (LOCAL_MOCKS)
        await fetch(`${API_BASE_URL}/api/v1/auth/local-session`, { credentials: "include" });
      await refreshWorkspace(() => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function switchAccount(accountId: string) {
    setNotice(null);
    try {
      await client.switchAccount(accountId);
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Account switch unavailable");
    }
  }

  async function createInvitation(input: InvitationCreate) {
    if (!activeAccount) return;
    setNotice(null);
    try {
      await client.createInvitation(activeAccount.accountId, input);
      setNotice("Invitation created through the approved delivery boundary.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Invitation unavailable");
    }
  }

  async function acceptInvitation(token: string) {
    setNotice(null);
    try {
      await client.acceptInvitation(token);
      setNotice("Invitation accepted. The server selected the active workspace.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Invitation unavailable");
      throw cause;
    }
  }

  async function createAssessment(input: AssessmentCreate) {
    if (!activeAccount) return;
    setNotice(null);
    try {
      await client.createAssessment(activeAccount.accountId, input);
      setNotice("Authorized draft saved. No assessment has executed.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Assessment unavailable");
    }
  }

  async function queueAssessment(assessmentId: string) {
    if (!activeAccount) return;
    setNotice(null);
    try {
      await client.queueAssessment(activeAccount.accountId, assessmentId);
      setNotice("Accepted by the queue boundary. No runner execution is implied locally.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Queue unavailable");
    }
  }

  return (
    <CustomerConsole
      status={status}
      localMocks={LOCAL_MOCKS}
      activeView={activeView}
      accounts={accounts}
      memberships={memberships}
      assessments={assessments}
      busy={busy}
      error={error}
      notice={notice}
      onNavigate={setActiveView}
      onRetry={refreshWorkspace}
      onSwitch={switchAccount}
      onInvite={createInvitation}
      onAccept={acceptInvitation}
      onCreate={createAssessment}
      onQueue={queueAssessment}
    />
  );
}
