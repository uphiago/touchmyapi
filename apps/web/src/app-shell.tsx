import type { AccountSummary } from "../../../packages/contracts/src";

export type ApiStatus = "checking" | "online" | "unavailable";
export type CustomerView = "overview" | "assessments" | "team" | "billing" | "workspace";

const navigation: readonly { key: CustomerView; label: string; index: string }[] = [
  { key: "overview", label: "Overview", index: "01" },
  { key: "assessments", label: "Assessments", index: "02" },
  { key: "team", label: "Team", index: "03" },
  { key: "billing", label: "Billing", index: "04" },
  { key: "workspace", label: "Workspace", index: "05" },
];

function navigationFor(role: AccountSummary["role"] | undefined) {
  if (role === "billing") {
    return navigation.filter((item) => ["overview", "billing", "workspace"].includes(item.key));
  }
  if (role === "owner" || role === "admin") {
    return navigation.filter((item) => item.key !== "billing");
  }
  return navigation.filter((item) => ["overview", "assessments", "workspace"].includes(item.key));
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export type AppShellProps = Readonly<{
  status: ApiStatus;
  localMocks: boolean;
  activeView: CustomerView;
  activeAccount?: AccountSummary;
  email: string;
  plan: string;
  onNavigate: (view: CustomerView) => void;
  onLogout: () => void | Promise<void>;
  children: React.ReactNode;
}>;

export function AppShell({
  status,
  localMocks,
  activeView,
  activeAccount,
  email,
  plan,
  onNavigate,
  onLogout,
  children,
}: AppShellProps) {
  const statusLabel =
    status === "checking" ? "Checking API" : status === "online" ? "API online" : "API unavailable";

  return (
    <div className="app-frame">
      <aside className="nav-rail">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            T/
          </span>
          <div>
            <strong>TouchMyAPI</strong>
            <span>Authorized operations</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Customer console">
          {navigationFor(activeAccount?.role).map((item, index) => (
            <button
              className={`nav-item${activeView === item.key ? " nav-item--active" : ""}`}
              type="button"
              key={item.key}
              aria-current={activeView === item.key ? "page" : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="rail-context">
          <span className="context-label">Active workspace</span>
          <strong>
            {activeAccount
              ? (activeAccount.displayName ?? shortId(activeAccount.accountId))
              : "No workspace"}
          </strong>
          <span>
            {activeAccount ? `${activeAccount.role} · ${activeAccount.status}` : "Sign in required"}
          </span>
          <button className="rail-signout" type="button" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="app-surface">
        {localMocks ? (
          <div className="environment-banner" role="status">
            <strong>Local demonstration</strong>
            <span>Server mocks only — no target is contacted and no runner executes.</span>
          </div>
        ) : null}
        <header className="topbar">
          <div>
            <span className="topbar-kicker">Customer console</span>
            <span className="topbar-context">
              {email} · {activeAccount?.role ?? "no role"} · {plan.replaceAll("_", " ")}
            </span>
          </div>
          <div className={`api-indicator api-indicator--${status}`} aria-label={statusLabel}>
            <span aria-hidden="true" />
            {statusLabel}
          </div>
        </header>
        <main className="content-stage">{children}</main>
      </div>
    </div>
  );
}
