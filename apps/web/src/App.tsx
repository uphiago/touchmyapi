import { useEffect, useMemo, useState } from "react";
import {
  healthResponseSchema,
  type AccountSummary,
  type InvitationCreate,
  type Membership,
} from "../../../packages/contracts/src";
import { ApiClientError, createApiClient } from "../../../packages/ui/api-client";
import { AccountSwitcher } from "./account-switcher";
import { Memberships } from "./memberships";

type ApiStatus = "checking" | "online" | "unavailable";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  const [memberships, setMemberships] = useState<readonly Membership[]>([]);
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
      if (!active) {
        setMemberships([]);
        return;
      }
      const membershipSnapshot = await client.listMemberships(active.accountId);
      if (cancelled?.()) return;
      setMemberships(membershipSnapshot.memberships);
    } catch (cause) {
      if (cancelled?.()) return;
      setError(cause instanceof ApiClientError ? cause.message : "Workspace unavailable");
    } finally {
      if (!cancelled?.()) setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${API_BASE_URL}/health`);
        if (!response.ok) {
          if (!cancelled) setStatus("unavailable");
          return;
        }
        const parsed = healthResponseSchema.safeParse(await response.json());
        if (!cancelled) setStatus(parsed.success ? "online" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }

    void checkHealth();

    void refreshWorkspace(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, []);

  async function switchAccount(accountId: string): Promise<void> {
    setNotice(null);
    try {
      await client.switchAccount(accountId);
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Account switch unavailable");
    }
  }

  async function createInvitation(input: InvitationCreate): Promise<void> {
    if (!activeAccount) return;
    setNotice(null);
    try {
      await client.createInvitation(activeAccount.accountId, input);
      setNotice("Invitation created. Deliver it through your approved channel.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Invitation unavailable");
    }
  }

  async function acceptInvitation(token: string): Promise<void> {
    setNotice(null);
    try {
      await client.acceptInvitation(token);
      setNotice("Invitation accepted. The server selected the active account.");
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "Invitation unavailable");
      throw cause;
    }
  }

  const statusLabel =
    status === "checking"
      ? "Checking API…"
      : status === "online"
        ? "API online"
        : "API indisponível";

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <div className="eyebrow">TouchMyAPI / console</div>
          <h1>Authorized security workspaces.</h1>
          <p className="tagline">Every account and membership decision comes from the server.</p>
        </div>
        <div className={`status status--${status}`} aria-label="API status">
          <span className="status__dot" />
          {statusLabel}
        </div>
      </header>
      <div className="workspace-grid">
        <AccountSwitcher accounts={accounts} busy={busy} onSwitch={switchAccount} />
        <section className="panel panel--status" aria-live="polite">
          <div className="eyebrow">Operational note</div>
          <h2>{activeAccount ? "Session anchored" : "Waiting for session"}</h2>
          <p className="panel__hint">
            {activeAccount
              ? `Active role: ${activeAccount.role}. Browser state is display-only.`
              : "Sign in to load the accounts visible to your session."}
          </p>
          {error ? <p className="message message--error">{error}</p> : null}
          {notice ? <p className="message message--success">{notice}</p> : null}
        </section>
        {activeAccount ? (
          <Memberships
            accountId={activeAccount.accountId}
            memberships={memberships}
            busy={busy}
            onInvite={createInvitation}
            onAccept={acceptInvitation}
          />
        ) : (
          <section className="panel empty-state">
            No account data is available for this session.
          </section>
        )}
      </div>
    </main>
  );
}
