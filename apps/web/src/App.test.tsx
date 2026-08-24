import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerConsole } from "./App";

const accountId = "00000000-0000-4000-8000-000000000101";

describe("customer operational console", () => {
  it("renders the application navigation, local boundary, and primary assessment action", () => {
    const markup = renderToStaticMarkup(
      <CustomerConsole
        status="online"
        localMocks
        activeView="overview"
        session={{
          user: { id: "00000000-0000-4000-8000-000000000103", email: "owner@example.test" },
          account: { id: accountId, role: "owner", plan: "free_unverified", iaEnabled: true },
        }}
        accounts={[{ accountId, role: "owner", status: "active", active: true }]}
        memberships={[]}
        assessments={[]}
        busy={false}
        error={null}
        notice={null}
        onNavigate={() => undefined}
        onRetry={() => undefined}
        onSwitch={() => undefined}
        onInvite={() => undefined}
        onAccept={() => undefined}
        onCreate={() => undefined}
        onQueue={() => undefined}
        onLogout={() => undefined}
      />,
    );

    for (const label of ["Overview", "Assessments", "Team", "Workspace"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Local demonstration");
    expect(markup).toContain("New assessment");
    expect(markup).toContain("Your owner workflow");
    expect(markup).toContain("Delivery is plan-filtered by the server");
    expect(markup).toContain("owner");
    expect(markup).toContain("API online");
    expect(markup).not.toContain("assessment executed");
  });

  it("keeps API health distinct from an unavailable authenticated workspace", () => {
    const markup = renderToStaticMarkup(
      <CustomerConsole
        status="online"
        localMocks={false}
        activeView="overview"
        session={{
          user: { id: "00000000-0000-4000-8000-000000000103", email: "owner@example.test" },
          account: { id: accountId, role: "owner", plan: "free_unverified", iaEnabled: true },
        }}
        accounts={[]}
        memberships={[]}
        assessments={[]}
        busy={false}
        error="Workspace unavailable"
        notice={null}
        onNavigate={() => undefined}
        onRetry={() => undefined}
        onSwitch={() => undefined}
        onInvite={() => undefined}
        onAccept={() => undefined}
        onCreate={() => undefined}
        onQueue={() => undefined}
        onLogout={() => undefined}
      />,
    );

    expect(markup).toContain("API online");
    expect(markup).toContain("Workspace unavailable");
    expect(markup).toContain("Retry workspace");
    expect(markup).not.toContain("No active accounts");
  });

  it("tailors navigation and actions to viewer and billing roles", () => {
    const viewer = renderToStaticMarkup(
      <CustomerConsole
        status="online"
        localMocks={false}
        activeView="assessments"
        session={{
          user: { id: "00000000-0000-4000-8000-000000000103", email: "viewer@example.test" },
          account: { id: accountId, role: "viewer", plan: "free_unverified", iaEnabled: true },
        }}
        accounts={[{ accountId, role: "viewer", status: "active", active: true }]}
        memberships={[]}
        assessments={[]}
        busy={false}
        error={null}
        notice={null}
        onNavigate={() => undefined}
        onRetry={() => undefined}
        onSwitch={() => undefined}
        onInvite={() => undefined}
        onAccept={() => undefined}
        onCreate={() => undefined}
        onQueue={() => undefined}
        onLogout={() => undefined}
      />,
    );
    expect(viewer).toContain("Read-only access");
    expect(viewer).not.toContain("New assessment");
    expect(viewer).not.toContain(">Team<");

    const billing = renderToStaticMarkup(
      <CustomerConsole
        status="online"
        localMocks={false}
        activeView="billing"
        session={{
          user: { id: "00000000-0000-4000-8000-000000000104", email: "billing@example.test" },
          account: { id: accountId, role: "billing", plan: "free_unverified", iaEnabled: false },
        }}
        accounts={[{ accountId, role: "billing", status: "active", active: true }]}
        memberships={[]}
        assessments={[]}
        busy={false}
        error={null}
        notice={null}
        onNavigate={() => undefined}
        onRetry={() => undefined}
        onSwitch={() => undefined}
        onInvite={() => undefined}
        onAccept={() => undefined}
        onCreate={() => undefined}
        onQueue={() => undefined}
        onLogout={() => undefined}
      />,
    );
    expect(billing).toContain("Billing &amp; plan");
    expect(billing).not.toContain(">Assessments<");
    expect(billing).not.toContain(">Team<");
  });
});
