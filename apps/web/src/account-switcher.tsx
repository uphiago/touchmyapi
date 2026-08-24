import type { AccountSummary } from "../../../packages/contracts/src";

export type AccountSwitcherProps = Readonly<{
  accounts: readonly AccountSummary[];
  busy: boolean;
  onSwitch: (accountId: string) => void | Promise<void>;
}>;

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export function AccountSwitcher({ accounts, busy, onSwitch }: AccountSwitcherProps) {
  const activeAccount = accounts.find((account) => account.active) ?? accounts[0];
  const selectedAccountId = activeAccount?.accountId ?? "";

  return (
    <section className="panel panel--switcher" aria-labelledby="account-switcher-title">
      <div className="eyebrow">Workspace control</div>
      <h2 id="account-switcher-title">Active account</h2>
      <p className="panel__hint">The server chooses which accounts and roles are available.</p>
      <label className="field-label" htmlFor="active-account">
        Account
      </label>
      <select
        id="active-account"
        className="field-control"
        aria-label="Active account"
        value={selectedAccountId}
        disabled={busy || accounts.length === 0}
        onChange={(event) => onSwitch(event.currentTarget.value)}
      >
        {accounts.length === 0 ? <option value="">No active accounts</option> : null}
        {accounts.map((account) => (
          <option key={account.accountId} value={account.accountId}>
            {account.displayName ?? account.accountId} · {label(account.role)} ·{" "}
            {label(account.status)}
          </option>
        ))}
      </select>
      <div className="badge-row" aria-live="polite">
        <span className="badge badge--accent">
          {activeAccount ? label(activeAccount.role) : "none"}
        </span>
        <span className="badge">{activeAccount ? label(activeAccount.status) : "unavailable"}</span>
      </div>
    </section>
  );
}
