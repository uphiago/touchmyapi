import { useState } from "react";
import type { InvitationCreate, Membership, MembershipRole } from "../../../packages/contracts/src";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type MembershipsProps = Readonly<{
  accountId: string;
  memberships: readonly Membership[];
  busy: boolean;
  onInvite: (input: InvitationCreate) => void | Promise<void>;
  onAccept: (token: string) => void | Promise<void>;
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
  onInvite,
  onAccept,
}: MembershipsProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("viewer");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [token, setToken] = useState("");

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onInvite({ email, role, expiresAt });
    setEmail("");
    setExpiresAt(defaultExpiry());
  }

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
                <strong>{membership.userId}</strong>
                <span className="member-meta">{membership.status}</span>
              </div>
              <span className="badge badge--accent">{label(membership.role)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="form-grid">
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

        <form onSubmit={submitAccept} className="subpanel">
          <div className="eyebrow">Accept</div>
          <h3>Join another account</h3>
          <label className="field-label" htmlFor="invite-token">
            Invitation token
          </label>
          <input
            id="invite-token"
            className="field-control"
            type="password"
            inputMode="text"
            required
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            autoComplete="off"
          />
          <p className="panel__hint">
            The token is submitted in the request body and cleared immediately.
          </p>
          <button className="button button--secondary" type="submit" disabled={busy}>
            Accept invitation
          </button>
        </form>
      </div>
    </section>
  );
}
