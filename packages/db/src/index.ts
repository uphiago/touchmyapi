export * from "../schema";
export {
  closeSystemAuditDatabase,
  closeTenantDatabase,
  createSystemAuditDatabase,
  createTenantDatabase,
} from "./connection-internal";
export type { SystemAuditDatabase, TenantDatabase } from "./connection-internal";
export {
  closeAuthDatabase,
  createAuthDatabase,
  type AuthDatabase,
} from "./auth-connection-internal";
export {
  acceptAuthInvitation,
  completeProviderLogin,
  createAuthInvitation,
  listAuthMemberships,
  listSessionAccounts,
  resolveAuthSession,
  revokeAuthSession,
  rotateAuthSession,
  switchAuthAccount,
  updateAuthMembership,
  type AcceptAuthInvitationInput,
  type AuthInvitationAcceptance,
  type AuthAccountInput,
  type AuthProvider,
  type AuthSessionRecord,
  type CompleteProviderLoginInput,
  type CreateAuthInvitationInput,
  type RotateAuthSessionInput,
  type SwitchAuthAccountInput,
  type UpdateAuthMembershipInput,
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
export {
  publishSucceededJob,
  publishTerminalJob,
  readClaimedWorkerJob,
  readSucceededRunnerResult,
  readSucceededReportContext,
  recordClaimedRunnerResult,
  type ClaimedJobRef,
  type ClaimedWorkerJob,
  type DeliveryFindingInput,
  type PublishSucceededJobInput,
  type ReportPublicationInput,
  type RunnerResultInput,
  type SucceededJobRef,
  type SucceededReportContext,
} from "./worker-delivery";

export { withTenant } from "./tenant-session";
export type { RuntimeRole, TenantContext } from "./tenant-session";
export {
  createAssessment,
  listAssessments,
  queueAssessment,
  readAssessmentPolicySnapshot,
  type AssessmentPolicySnapshot,
  type CreateAssessmentInput,
  type QueueAssessmentInput,
} from "./tenant-assessment";
export {
  listTenantNotifications,
  listTenantReports,
  readTenantReportObjectKey,
  markTenantNotificationRead,
  readTenantAssessmentDelivery,
  type TenantAssessmentDelivery,
  type TenantFinding,
} from "./tenant-delivery";
export { withSystemAudit } from "./system-audit-session";
export type { SystemAuditContext } from "./system-audit-session";
export {
  appendAuditEvent,
  appendSystemAuditEvent,
  type AuditAppendInput,
  type AppendedAuditEvent,
} from "./audit";
