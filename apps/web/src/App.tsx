import { useEffect, useMemo, useState } from "react";
import {
  healthResponseSchema,
  type AccountSummary,
  type Assessment,
  type AssessmentCreate,
  type AuthProvider,
  type AuthSessionResponse,
  type InvitationCreate,
  type Membership,
  type MembershipUpdate,
} from "../../../packages/contracts/src";
import { ApiClientError, createApiClient } from "../../../packages/ui/api-client";
import { AccountSwitcher } from "./account-switcher";
import { AppShell, type ApiStatus, type CustomerView } from "./app-shell";
import { Assessments } from "./assessments";
import { LandingPage } from "./landing";
import { InvitationAcceptance, Memberships } from "./memberships";
import { Overview } from "./overview";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";
const LOCAL_MOCKS = import.meta.env.VITE_LOCAL_MOCKS === "1";

export type CustomerConsoleProps = Readonly<{
  status: ApiStatus;
  localMocks: boolean;
  activeView: CustomerView;
  session: AuthSessionResponse;
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
  onUpdateMember?: (userId: string, input: MembershipUpdate) => void | Promise<void>;
  onRemoveMember?: (userId: string) => void | Promise<void>;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
  onQueue: (assessmentId: string) => void | Promise<void>;
  onLogout: () => void | Promise<void>;
}>;

export function CustomerConsole({
  status,
  localMocks,
  activeView,
  session,
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
  onUpdateMember,
  onRemoveMember,
  onCreate,
  onQueue,
  onLogout,
}: CustomerConsoleProps) {
  const activeAccount = accounts.find((account) => account.active) ?? accounts[0];
  const role = activeAccount?.role ?? session.account.role;
  const canCreateAssessment = role === "owner" || role === "admin" || role === "operator";
  const canReadAssessments = role !== "billing";
  const canManageTeam = role === "owner" || role === "admin";
  let content: React.ReactNode;

  if (!activeAccount) {
    content = (
      <section className="session-empty">
        <span className="eyebrow">Workspace session</span>
        <h1>You are signed in, but no active workspace is available.</h1>
        <p>{error ?? "Refresh the server-selected account and membership snapshot."}</p>
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
        plan={session.account.plan}
        assessments={assessments}
        memberCount={memberships.length}
        canCreate={canCreateAssessment}
        onNewAssessment={() => onNavigate("assessments")}
      />
    );
  } else if (activeView === "assessments" && canReadAssessments) {
    content = (
      <Assessments
        assessments={assessments}
        busy={busy}
        plan={session.account.plan}
        canCreate={canCreateAssessment}
        canQueue={canCreateAssessment}
        onCreate={onCreate}
        onQueue={onQueue}
      />
    );
  } else if (activeView === "team" && canManageTeam) {
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
          canInvite={canManageTeam}
          onInvite={onInvite}
          onAccept={onAccept}
          onUpdate={onUpdateMember}
          onRemove={onRemoveMember}
        />
      </div>
    );
  } else if (activeView === "billing" && role === "billing") {
    content = (
      <div className="view-stack">
        <section className="page-intro page-intro--compact">
          <div>
            <span className="eyebrow">Billing authority</span>
            <h1>Billing &amp; plan</h1>
            <p>
              Your billing role can review the current plan. Entitlements change only after a
              verified Stripe webhook; this console never grants access directly.
            </p>
          </div>
        </section>
        <section className="section-block billing-summary">
          <div>
            <span className="eyebrow">Current server snapshot</span>
            <h2>{session.account.plan.replaceAll("_", " ")}</h2>
          </div>
          <span className="access-mode">Read-only billing</span>
        </section>
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
        <InvitationAcceptance busy={busy} onAccept={onAccept} />
      </div>
    );
  }

  return (
    <AppShell
      status={status}
      localMocks={localMocks}
      activeView={activeView}
      activeAccount={activeAccount}
      email={session.user.email}
      plan={session.account.plan}
      onNavigate={onNavigate}
      onLogout={onLogout}
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
  const [authState, setAuthState] = useState<
    "checking" | "signed_out" | "signed_in" | "unavailable"
  >("checking");
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [providers, setProviders] = useState<readonly AuthProvider[]>([]);
  const [session, setSession] = useState<AuthSessionResponse>();
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
      const canManageTeam = active.role === "owner" || active.role === "admin";
      const canReadAssessments = active.role !== "billing";
      const [membershipSnapshot, assessmentSnapshot] = await Promise.all([
        canManageTeam
          ? client.listMemberships(active.accountId)
          : Promise.resolve({ memberships: [] }),
        canReadAssessments
          ? client.listAssessments(active.accountId)
          : Promise.resolve({ assessments: [] }),
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
      try {
        const providerSnapshot = await client.getAuthProviders();
        if (cancelled) return;
        setProviders(providerSnapshot.providers);
        if (LOCAL_MOCKS) {
          await fetch(`${API_BASE_URL}/api/v1/auth/local-session`, { credentials: "include" });
        }
        const currentSession = await client.getSession();
        if (cancelled) return;
        setSession(currentSession);
        setAuthState("signed_in");
        await refreshWorkspace(() => cancelled);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiClientError && cause.status === 401) {
          setAuthState("signed_out");
          setError(null);
        } else {
          setAuthState("unavailable");
          setError(cause instanceof ApiClientError ? cause.message : "Authentication unavailable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function switchAccount(accountId: string) {
    setNotice(null);
    try {
      await client.switchAccount(accountId);
      setSession(await client.getSession());
      setActiveView("overview");
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
      setSession(await client.getSession());
      setNotice("Invitation accepted. The server selected the active workspace.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Invitation unavailable");
      throw cause;
    }
  }

  async function updateMember(userId: string, input: MembershipUpdate) {
    if (!activeAccount) return;
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      await client.updateMembership(activeAccount.accountId, userId, input);
      setNotice("Membership updated. Security-sensitive role changes revoke active sessions.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Membership update unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    if (!activeAccount) return;
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      await client.removeMembership(activeAccount.accountId, userId);
      setNotice("Member removed and account sessions revoked.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Membership removal unavailable");
    } finally {
      setBusy(false);
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

  async function logout() {
    setBusy(true);
    try {
      await client.logout();
    } finally {
      setSession(undefined);
      setAccounts([]);
      setMemberships([]);
      setAssessments([]);
      setActiveView("overview");
      setAuthState("signed_out");
      setBusy(false);
    }
  }

  function startGitHubLogin() {
    window.location.assign(`${API_BASE_URL.replace(/\/+$/u, "")}/api/v1/auth/github/start`);
  }

  if (authState === "checking") {
    return (
      <div className="product-boot" role="status">
        <span className="brand-mark" aria-hidden="true">
          T/
        </span>
        <p>Establishing a secure workspace session…</p>
      </div>
    );
  }

  if (authState !== "signed_in" || !session) {
    return (
      <LandingPage
        status={status}
        providers={providers}
        busy={busy}
        error={error}
        onGitHub={startGitHubLogin}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return (
    <CustomerConsole
      status={status}
      localMocks={LOCAL_MOCKS}
      activeView={activeView}
      session={session}
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
      onUpdateMember={updateMember}
      onRemoveMember={removeMember}
      onCreate={createAssessment}
      onQueue={queueAssessment}
      onLogout={logout}
    />
  );
}
