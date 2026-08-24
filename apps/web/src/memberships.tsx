import { useState } from "react";
import type {
  InvitationCreate,
  Membership,
  MembershipRole,
  MembershipUpdate,
} from "../../../packages/contracts/src";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type MembershipsProps = Readonly<{
  accountId: string;
  memberships: readonly Membership[];
  busy: boolean;
  canInvite?: boolean;
  onInvite: (input: InvitationCreate) => void | Promise<void>;
  onAccept: (token: string) => void | Promise<void>;
  onUpdate?: (userId: string, input: MembershipUpdate) => void | Promise<void>;
  onRemove?: (userId: string) => void | Promise<void>;
}>;

const roles: readonly MembershipRole[] = ["owner", "admin", "operator", "viewer", "billing"];

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function defaultExpiry(): string {
  return new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString();
}

export function Memberships({
  accountId,
  memberships,
  busy,
  canInvite = true,
  onInvite,
  onUpdate,
  onRemove,
}: MembershipsProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("viewer");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onInvite({ email, role, expiresAt });
    setEmail("");
    setExpiresAt(defaultExpiry());
  }

  return (
    <section className="panel panel--members" aria-labelledby="members-title">
      <div className="eyebrow">Account membership</div>
      <div className="panel__header">
        <div>
          <h2 id="members-title">People with access</h2>
          <p className="panel__hint">Account {accountId} · server-provided membership snapshot</p>
        </div>
        <span className="badge">{memberships.length} members</span>
      </div>

      {memberships.length === 0 ? (
        <p className="empty-state">No memberships are visible for this account.</p>
      ) : (
        <ul className="member-list">
          {memberships.map((membership) => (
            <li className="member-row" key={membership.id}>
              <div>
                <strong>{membership.email ?? `${membership.userId.slice(0, 8)}…`}</strong>
                <span className="member-meta">
                  {membership.userId.slice(0, 8)} · {membership.status}
                </span>
              </div>
              {onUpdate && onRemove ? (
                <div className="member-actions">
                  <select
                    className="field-control field-control--member"
                    aria-label={`Role for ${membership.email ?? membership.userId}`}
                    value={membership.role}
                    disabled={busy || membership.status === "removed"}
                    onChange={(event) =>
                      void onUpdate(membership.userId, {
                        role: event.currentTarget.value as MembershipRole,
                      })
                    }
                  >
                    {roles.map((option) => (
                      <option key={option} value={option}>
                        {label(option)}
                      </option>
                    ))}
                  </select>
                  {membership.status !== "removed" ? (
                    <button
                      className="member-state-action"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onUpdate(membership.userId, {
                          status: membership.status === "active" ? "suspended" : "active",
                        })
                      }
                    >
                      {membership.status === "active" ? "Suspend" : "Reactivate"}
                    </button>
                  ) : null}
                  <button
                    className="member-remove"
                    type="button"
                    disabled={busy || membership.status === "removed"}
                    onClick={() => {
                      if (
                        window.confirm("Remove this member and revoke their workspace sessions?")
                      ) {
                        void onRemove(membership.userId);
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="badge badge--accent">{label(membership.role)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canInvite ? (
        <div className="form-grid form-grid--single">
          <form onSubmit={submitInvite} className="subpanel">
            <div className="eyebrow">Invite</div>
            <h3>Grant account access</h3>
            <label className="field-label" htmlFor="invite-email">
              Email
            </label>
            <input
              id="invite-email"
              className="field-control"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              autoComplete="email"
            />
            <label className="field-label" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="field-control"
              value={role}
              onChange={(event) => setRole(event.currentTarget.value as MembershipRole)}
            >
              {roles.map((option) => (
                <option key={option} value={option}>
                  {label(option)}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="invite-expiry">
              Expires
            </label>
            <input
              id="invite-expiry"
              className="field-control"
              type="datetime-local"
              required
              value={expiresAt.slice(0, 16)}
              onChange={(event) => setExpiresAt(new Date(event.currentTarget.value).toISOString())}
            />
            <button className="button button--primary" type="submit" disabled={busy}>
              Create invitation
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export function InvitationAcceptance({
  busy,
  onAccept,
}: Pick<MembershipsProps, "busy" | "onAccept">) {
  const [token, setToken] = useState("");

  async function submitAccept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedToken = token;
    setToken("");
    try {
      await onAccept(submittedToken);
    } catch {
      // The parent owns the visible error state. The input remains cleared.
    }
  }

  return (
    <form onSubmit={submitAccept} className="section-block invitation-acceptance">
      <div>
        <span className="eyebrow">Invitation</span>
        <h2>Join another workspace</h2>
        <p className="section-copy">
          Paste the one-time token from your invitation. It is sent only in the request body and
          cleared immediately.
        </p>
      </div>
      <div>
        <label className="field-label" htmlFor="workspace-invite-token">
          Invitation token
        </label>
        <input
          id="workspace-invite-token"
          className="field-control"
          type="password"
          inputMode="text"
          required
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          autoComplete="off"
        />
        <button className="button button--secondary" type="submit" disabled={busy}>
          Accept invitation
        </button>
      </div>
    </form>
  );
}
