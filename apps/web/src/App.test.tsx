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
      />,
    );

    for (const label of ["Overview", "Assessments", "Team", "Workspace"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Local demonstration");
    expect(markup).toContain("New assessment");
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
      />,
    );

    expect(markup).toContain("API online");
    expect(markup).toContain("Workspace unavailable");
    expect(markup).toContain("Retry workspace");
    expect(markup).not.toContain("No active accounts");
  });
});
