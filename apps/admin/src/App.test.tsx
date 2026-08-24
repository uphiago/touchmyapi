import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminSnapshot } from "@touchmyapi/contracts";
import { AdminConsole } from "./App";

const snapshot: AdminSnapshot = {
  session: { staffId: "local-operator", email: "local.operator@example.test", mode: "local-mock" },
  operations: {
    api: "online",
    database: "online",
    worker: "mock-idle",
    queueDepth: 1,
    oldestJobAgeSeconds: 84,
    activeAlerts: 0,
  },
  accounts: [
    {
      accountId: "00000000-0000-4000-8000-000000000101",
      displayName: "Local authorized workspace",
      status: "active",
      plan: "free_unverified",
      memberCount: 1,
    },
  ],
  queue: [
    {
      jobId: "00000000-0000-4000-8000-000000000201",
      accountId: "00000000-0000-4000-8000-000000000101",
      targetLabel: "redacted local target",
      status: "queued",
      enqueuedAt: "2026-08-23T12:00:00.000Z",
    },
  ],
  grants: [],
  audit: [],
  billing: { mode: "read-only", webhookStatus: "mock-current" },
};

describe("admin console", () => {
  it("renders the separated staff navigation and truthful mock boundary", () => {
    const markup = renderToStaticMarkup(
      <AdminConsole snapshot={snapshot} activeView="operations" />,
    );
    for (const label of ["Operations", "Accounts", "Queue", "Access grants", "Billing", "Audit"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("LOCAL STAFF SIMULATION");
    expect(markup).toContain("No customer impersonation");
  });

  it("keeps billing read-only and makes grant-before-action explicit", () => {
    const billing = renderToStaticMarkup(<AdminConsole snapshot={snapshot} activeView="billing" />);
    expect(billing).toContain("Read-only billing");
    expect(billing).not.toContain("Grant credits");
    const grants = renderToStaticMarkup(<AdminConsole snapshot={snapshot} activeView="access" />);
    expect(grants).toContain("Request capability grant");
    expect(grants).toContain("distinct mock approver");
  });
});
