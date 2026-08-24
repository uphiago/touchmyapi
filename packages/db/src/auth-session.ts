import type {
  AccountSummary,
  Invitation,
  Membership,
  MembershipRole,
  MembershipStatus,
} from "@touchmyapi/contracts";
import { getRawAuthDatabase, type AuthDatabase } from "./auth-connection-internal";
import type { RawDbConnection } from "./connection-internal";

export type AuthProvider = "github" | "google";

export type AuthSessionRecord = Readonly<{
  userId: string;
  accountId: string;
  sessionId: string;
  email: string;
  role: MembershipRole;
  membershipStatus: MembershipStatus;
  plan: string;
  iaEnabled: boolean;
}>;

export type CompleteProviderLoginInput = Readonly<{
  provider: AuthProvider;
  providerSubject: string;
  email: string;
  sessionHash: string;
  expiresAt: Date;
  ip?: string;
  userAgent?: string;
}>;

export type RotateAuthSessionInput = Readonly<{
  currentSessionHash: string;
  replacementSessionHash: string;
  replacementExpiresAt: Date;
}>;

export type SwitchAuthAccountInput = Readonly<{
  sessionHash: string;
  targetAccountId: string;
  replacementSessionHash: string;
  replacementExpiresAt: Date;
}>;

export type AcceptAuthInvitationInput = Readonly<{
  sessionHash: string;
  tokenHash: string;
  replacementSessionHash: string;
  replacementExpiresAt: Date;
}>;

export type AuthInvitationAcceptance = Readonly<{
  session: AuthSessionRecord;
  rotated: boolean;
}>;

export type AuthAccountInput = Readonly<{ sessionHash: string; accountId: string }>;

export type CreateAuthInvitationInput = AuthAccountInput &
  Readonly<{
    email: string;
    role: MembershipRole;
    tokenHash: string;
    expiresAt: Date;
  }>;

export type UpdateAuthMembershipInput = AuthAccountInput &
  Readonly<{
    userId: string;
    role?: MembershipRole;
    status?: MembershipStatus;
  }>;

type Principal = Readonly<{ backendPid: number; sessionPrincipal: string }>;

function rejectConnection(reasons: readonly string[]): never {
  throw new Error(`auth connection rejected: ${reasons.join(", ")}`);
}

async function assertConnector(connection: RawDbConnection): Promise<Principal> {
  const rows = await connection.unsafe(
    `select current_user::text as principal, session_user::text as session_principal,
       pg_backend_pid() as backend_pid, role.rolsuper as is_superuser,
       role.rolbypassrls as bypasses_rls, role.rolinherit as inherits_roles,
       role.rolcreatedb as can_create_db, role.rolcreaterole as can_create_role,
       role.rolreplication as can_replicate,
       pg_has_role(current_user, 'auth_bootstrap', 'member') as bootstrap_member,
       exists (select 1 from pg_database database
               where database.datname = current_database() and database.datdba = role.oid) as database_owner,
       exists (select 1 from pg_class relation
               where relation.relnamespace = 'public'::regnamespace and relation.relowner = role.oid) as object_owner,
       exists (select 1 from information_schema.table_privileges privilege
               where privilege.grantee = current_user
                 and privilege.table_schema = 'public') as direct_table_access,
       exists (select 1 from pg_proc function
               cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
               where function.pronamespace = 'public'::regnamespace
                 and acl.grantee = role.oid and acl.privilege_type = 'EXECUTE') as direct_function_access
     from pg_roles role where role.rolname = current_user`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) rejectConnection(["principal unavailable"]);
  const reasons: string[] = [];
  if (row.principal !== row.session_principal) reasons.push("role already switched");
  if (row.is_superuser) reasons.push("superuser");
  if (row.bypasses_rls) reasons.push("BYPASSRLS");
  if (row.inherits_roles) reasons.push("INHERIT connector");
  if (row.can_create_db || row.can_create_role || row.can_replicate) reasons.push("elevated role");
  if (!row.bootstrap_member) reasons.push("not an auth_bootstrap member");
  if (row.database_owner) reasons.push("database owner");
  if (row.object_owner) reasons.push("public object owner");
  if (row.direct_table_access) reasons.push("direct table access");
  if (row.direct_function_access) reasons.push("direct function access");
  if (reasons.length) rejectConnection(reasons);
  return { backendPid: Number(row.backend_pid), sessionPrincipal: String(row.session_principal) };
}

async function assertBootstrap(connection: RawDbConnection, principal: Principal): Promise<void> {
  const rows = await connection.unsafe(
    `select current_user::text as principal, session_user::text as session_principal,
       pg_backend_pid() as backend_pid, role.rolsuper as is_superuser,
       role.rolbypassrls as bypasses_rls, role.rolinherit as inherits_roles,
       exists (select 1 from pg_database database
               where database.datname = current_database() and database.datdba = role.oid) as database_owner
     from pg_roles role where role.rolname = current_user`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const reasons: string[] = [];
  if (!row || row.principal !== "auth_bootstrap") reasons.push("role is not auth_bootstrap");
  if (row?.session_principal !== principal.sessionPrincipal)
    reasons.push("session principal changed");
  if (Number(row?.backend_pid) !== principal.backendPid) reasons.push("backend changed");
  if (row?.is_superuser || row?.bypasses_rls || row?.inherits_roles || row?.database_owner) {
    reasons.push("unsafe bootstrap role");
  }
  if (reasons.length) rejectConnection(reasons);
}

async function withAuthRole<T>(
  database: AuthDatabase,
  callback: (connection: RawDbConnection) => Promise<T>,
): Promise<T> {
  const raw = getRawAuthDatabase(database);
  const reserved = await raw.reserve();
  let transactionStarted = false;
  try {
    await reserved.unsafe("begin");
    transactionStarted = true;
    await reserved.unsafe("set local statement_timeout = '5s'");
    await reserved.unsafe("set local lock_timeout = '1s'");
    await reserved.unsafe("set local idle_in_transaction_session_timeout = '30s'");
    await reserved.unsafe("set local search_path = pg_catalog, public, pg_temp");
    const principal = await assertConnector(reserved);
    await reserved.unsafe('set local role "auth_bootstrap"');
    await assertBootstrap(reserved, principal);
    const result = await callback(reserved);
    await reserved.unsafe("reset role");
    await reserved.unsafe("commit");
    return result;
  } catch (error) {
    if (transactionStarted) await reserved.unsafe("rollback").catch(() => undefined);
    throw error;
  } finally {
    reserved.release();
  }
}

function mapSession(row: Record<string, unknown> | undefined): AuthSessionRecord | undefined {
  if (!row) return undefined;
  return Object.freeze({
    userId: String(row.user_id),
    accountId: String(row.account_id),
    sessionId: String(row.session_id),
    email: String(row.email),
    role: String(row.role) as MembershipRole,
    membershipStatus: String(row.membership_status) as MembershipStatus,
    plan: String(row.plan),
    iaEnabled: Boolean(row.ia_enabled),
  });
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function mapMembership(row: Record<string, unknown> | undefined): Membership | undefined {
  if (!row) return undefined;
  return Object.freeze({
    id: String(row.id),
    accountId: String(row.account_id),
    userId: String(row.user_id),
    ...(row.email ? { email: String(row.email) } : {}),
    role: String(row.role) as MembershipRole,
    status: String(row.status) as MembershipStatus,
    invitedByUserId: row.invited_by_user_id ? String(row.invited_by_user_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    removedAt: row.removed_at ? iso(row.removed_at) : null,
  });
}

function mapInvitation(row: Record<string, unknown> | undefined): Invitation | undefined {
  if (!row) return undefined;
  return Object.freeze({
    id: String(row.id),
    accountId: String(row.account_id),
    email: String(row.email),
    proposedRole: String(row.proposed_role) as MembershipRole,
    status: String(row.status) as Invitation["status"],
    expiresAt: iso(row.expires_at),
    acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
    createdAt: iso(row.created_at),
    invitedByUserId: String(row.invited_by_user_id),
    acceptedByUserId: row.accepted_by_user_id ? String(row.accepted_by_user_id) : null,
  });
}

async function snapshot(
  connection: RawDbConnection,
  sessionHash: string,
): Promise<AuthSessionRecord | undefined> {
  const rows = await connection.unsafe("select * from public.auth_session_snapshot($1::text)", [
    sessionHash,
  ]);
  return mapSession(rows[0] as Record<string, unknown> | undefined);
}

export async function completeProviderLogin(
  database: AuthDatabase,
  input: CompleteProviderLoginInput,
): Promise<AuthSessionRecord | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_complete_provider_login($1::public.identity_provider,$2::text,$3::public.citext,$4::text,$5::timestamptz,$6::inet,$7::text)",
      [
        input.provider,
        input.providerSubject,
        input.email,
        input.sessionHash,
        input.expiresAt,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
    if (rows.length === 0) return undefined;
    return snapshot(connection, input.sessionHash);
  });
}

export async function resolveAuthSession(
  database: AuthDatabase,
  sessionHash: string,
): Promise<AuthSessionRecord | undefined> {
  return withAuthRole(database, (connection) => snapshot(connection, sessionHash));
}

export async function rotateAuthSession(
  database: AuthDatabase,
  input: RotateAuthSessionInput,
): Promise<AuthSessionRecord | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_rotate_session($1::text,$2::text,$3::timestamptz)",
      [input.currentSessionHash, input.replacementSessionHash, input.replacementExpiresAt],
    );
    if (rows.length === 0) return undefined;
    return snapshot(connection, input.replacementSessionHash);
  });
}

export async function revokeAuthSession(
  database: AuthDatabase,
  sessionHash: string,
): Promise<boolean> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe("select public.auth_revoke_session($1::text) as revoked", [
      sessionHash,
    ]);
    return rows[0]?.revoked === true;
  });
}

export async function listSessionAccounts(
  database: AuthDatabase,
  sessionHash: string,
): Promise<readonly AccountSummary[]> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe("select * from public.auth_list_accounts($1::text)", [
      sessionHash,
    ]);
    return rows.map((row) => ({
      accountId: String(row.account_id),
      role: String(row.role) as MembershipRole,
      status: String(row.status) as MembershipStatus,
      active: Boolean(row.active),
    }));
  });
}

export async function listAuthMemberships(
  database: AuthDatabase,
  input: AuthAccountInput,
): Promise<readonly Membership[]> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_list_memberships($1::text,$2::uuid)",
      [input.sessionHash, input.accountId],
    );
    return rows.map((row) => mapMembership(row as Record<string, unknown>)!);
  });
}

export async function createAuthInvitation(
  database: AuthDatabase,
  input: CreateAuthInvitationInput,
): Promise<Invitation | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_create_invitation_snapshot($1::text,$2::uuid,$3::public.citext,$4::public.membership_role,$5::text,$6::timestamptz)",
      [
        input.sessionHash,
        input.accountId,
        input.email,
        input.role,
        input.tokenHash,
        input.expiresAt,
      ],
    );
    return mapInvitation(rows[0] as Record<string, unknown> | undefined);
  });
}

export async function updateAuthMembership(
  database: AuthDatabase,
  input: UpdateAuthMembershipInput,
): Promise<Membership | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_update_membership_secure($1::text,$2::uuid,$3::uuid,$4::public.membership_role,$5::public.membership_status)",
      [input.sessionHash, input.accountId, input.userId, input.role ?? null, input.status ?? null],
    );
    return mapMembership(rows[0] as Record<string, unknown> | undefined);
  });
}

export async function switchAuthAccount(
  database: AuthDatabase,
  input: SwitchAuthAccountInput,
): Promise<AuthSessionRecord | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_switch_account($1::text,$2::uuid,$3::text,$4::timestamptz)",
      [
        input.sessionHash,
        input.targetAccountId,
        input.replacementSessionHash,
        input.replacementExpiresAt,
      ],
    );
    if (rows.length === 0) return undefined;
    return snapshot(connection, input.replacementSessionHash);
  });
}

export async function acceptAuthInvitation(
  database: AuthDatabase,
  input: AcceptAuthInvitationInput,
): Promise<AuthInvitationAcceptance | undefined> {
  return withAuthRole(database, async (connection) => {
    const rows = await connection.unsafe(
      "select * from public.auth_accept_invitation($1::text,$2::text,$3::text,$4::timestamptz)",
      [
        input.sessionHash,
        input.tokenHash,
        input.replacementSessionHash,
        input.replacementExpiresAt,
      ],
    );
    if (rows.length === 0) return undefined;
    const rotated = await snapshot(connection, input.replacementSessionHash);
    if (rotated) return { session: rotated, rotated: true };
    const current = await snapshot(connection, input.sessionHash);
    return current ? { session: current, rotated: false } : undefined;
  });
}
