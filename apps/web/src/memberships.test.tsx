import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createApiClient, type Fetcher } from "../../../packages/ui/api-client";
import { AccountSwitcher } from "./account-switcher";
import { Memberships } from "./memberships";
import { Assessments } from "./assessments";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-08-23T12:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function account(active: boolean) {
  return { accountId, role: "owner", status: "active", active } as const;
}

describe("membership API client", () => {
  it("loads and validates the server account snapshot with credentials", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(response({ accounts: [account(true)] }));
    const client = createApiClient("https://api.example.test", fetcher);

    await expect(client.listAccounts()).resolves.toEqual({ accounts: [account(true)] });
    expect(fetcher).toHaveBeenCalledWith("https://api.example.test/api/v1/accounts", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("uses the account switch endpoint and JSON body", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue(response({ account: { id: otherAccountId, role: "viewer" } }));
    const client = createApiClient("https://api.example.test", fetcher);

    await expect(client.switchAccount(otherAccountId)).resolves.toEqual({
      account: { id: otherAccountId, role: "viewer" },
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.example.test/api/v1/account/switch", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: otherAccountId }),
    });
  });

  it("keeps invitation tokens in the JSON body and never in the URL", async () => {
    const token = "A".repeat(43);
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue(response({ account: { id: accountId, role: "viewer" } }));
    const client = createApiClient("https://api.example.test", fetcher);

    await client.acceptInvitation(token);

    const [requestUrl, requestInit] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://api.example.test/api/v1/invitations/accept");
    expect(requestUrl).not.toContain(token);
    expect(requestInit).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ token }),
    });
  });

  it("parses stable API errors without exposing arbitrary response details", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue(
        response({ error: { code: "membership_required", message: "Membership required" } }, 403),
      );
    const client = createApiClient("https://api.example.test", fetcher);

    await expect(client.listMemberships(accountId)).rejects.toMatchObject({
      name: "ApiClientError",
      status: 403,
      code: "membership_required",
      message: "Membership required",
    });
  });

  it("sends invitation creation and membership listing to the active account path", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(response({ memberships: [] }))
      .mockResolvedValueOnce(
        response({
          invitation: {
            id: "00000000-0000-4000-8000-000000000004",
            accountId,
            email: "invite@example.test",
            proposedRole: "viewer",
            status: "pending",
            expiresAt: "2026-08-30T12:00:00.000Z",
            acceptedAt: null,
            createdAt: timestamp,
            invitedByUserId: userId,
            acceptedByUserId: null,
          },
        }),
      );
    const client = createApiClient("https://api.example.test", fetcher);

    await client.listMemberships(accountId);
    await client.createInvitation(accountId, {
      email: "invite@example.test",
      role: "viewer",
      expiresAt: "2026-08-30T12:00:00.000Z",
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/api/v1/accounts/${accountId}/memberships`,
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.example.test/api/v1/accounts/${accountId}/memberships/invitations`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});

describe("membership workspace components", () => {
  it("renders the server-selected account and role/status labels", () => {
    const markup = renderToStaticMarkup(
      <AccountSwitcher
        accounts={[account(false), { ...account(true), accountId: otherAccountId, role: "viewer" }]}
        busy={false}
        onSwitch={() => undefined}
      />,
    );

    expect(markup).toContain(`value="${otherAccountId}" selected`);
    expect(markup).toContain("viewer");
    expect(markup).toContain("active");
  });

  it("renders membership role/status from the server and never renders an invitation token", () => {
    const token = "B".repeat(43);
    const markup = renderToStaticMarkup(
      <Memberships
        accountId={accountId}
        memberships={[
          {
            id: "00000000-0000-4000-8000-000000000005",
            accountId,
            userId,
            role: "operator",
            status: "suspended",
            invitedByUserId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            removedAt: null,
          },
        ]}
        busy={false}
        onInvite={() => undefined}
        onAccept={() => undefined}
      />,
    );

    expect(markup).toContain("operator");
    expect(markup).toContain("suspended");
    expect(markup).not.toContain(token);
    expect(markup).not.toContain("?token=");
  });

  it("renders assessment state from the server and exposes queue only for drafts", () => {
    const markup = renderToStaticMarkup(
      <Assessments
        assessments={[
          {
            id: "00000000-0000-4000-8000-000000000006",
            accountId,
            targetCategory: "surface",
            target: "example.test",
            scope: [],
            playbookId: "surface-public-posture",
            playbookVersion: "1.0.0",
            status: "draft",
            jobId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]}
        busy={false}
        onCreate={() => undefined}
        onQueue={() => undefined}
      />,
    );

    expect(markup).toContain("example.test");
    expect(markup).toContain(">Queue</button>");
  });
});
