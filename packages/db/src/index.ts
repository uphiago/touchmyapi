export * from "../schema";
export { createTenantDatabase } from "./connection-internal";
export { createSystemAuditDatabase } from "./connection-internal";
export type { SystemAuditDatabase, TenantDatabase } from "./connection-internal";
export {
  closeAuthDatabase,
  createAuthDatabase,
  type AuthDatabase,
} from "./auth-connection-internal";
export {
  acceptAuthInvitation,
  completeProviderLogin,
  listSessionAccounts,
  resolveAuthSession,
  revokeAuthSession,
  rotateAuthSession,
  switchAuthAccount,
  type AcceptAuthInvitationInput,
  type AuthInvitationAcceptance,
  type AuthProvider,
  type AuthSessionRecord,
  type CompleteProviderLoginInput,
  type RotateAuthSessionInput,
  type SwitchAuthAccountInput,
} from "./auth-session";
export { createInvitationToken, hashInvitationToken, invitationTokenPattern } from "./invitations";
export { ensureQueueState } from "./queue-bootstrap";
export type { QueueBootstrapOptions } from "./queue-bootstrap";
export { enqueueJob, QueueUnavailableError } from "./queue";
export {
  ackOutboxEvent,
  claimOutboxEvents,
  claimQueueJob,
  completeQueueJob,
  failOutboxEvent,
  failQueueJob,
  heartbeatOutboxEvent,
  heartbeatQueueJob,
  reapOutboxEvents,
  reapQueueJobs,
  reconcileQueueState,
} from "./queue-control";
export type { OutboxClaim, QueueClaim, QueueHeartbeat } from "./queue-control";

export { withTenant } from "./tenant-session";
export type { RuntimeRole, TenantContext } from "./tenant-session";
export { withSystemAudit } from "./system-audit-session";
export type { SystemAuditContext } from "./system-audit-session";
export {
  appendAuditEvent,
  appendSystemAuditEvent,
  type AuditAppendInput,
  type AppendedAuditEvent,
} from "./audit";
