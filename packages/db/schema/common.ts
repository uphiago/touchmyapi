import { customType } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";

export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const accountStatus = pgEnum("account_status", ["active", "deleted", "revoked"]);
export const identityProvider = pgEnum("identity_provider", ["google", "github", "x"]);
export const targetCategory = pgEnum("target_category", [
  "web",
  "api",
  "surface",
  "genai",
  "internal",
]);
export const assessmentStatus = pgEnum("assessment_status", [
  "draft",
  "awaiting_verification",
  "queued",
  "running",
  "analyzing",
  "completed",
  "failed",
  "cancelled",
]);
export const verificationMethod = pgEnum("verification_method", ["http_file", "dns_txt"]);
export const verificationStatus = pgEnum("verification_status", [
  "pending",
  "verified",
  "expired",
  "failed",
]);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale_recovered",
]);
export const severity = pgEnum("severity", ["info", "low", "medium", "high", "critical"]);
export const reportKind = pgEnum("report_kind", ["pdf_technical", "pdf_executive", "json"]);
export const billingProcessingStatus = pgEnum("billing_processing_status", [
  "received",
  "processed",
  "failed",
]);
export const entitlementPlan = pgEnum("entitlement_plan", [
  "free_unverified",
  "free_verified",
  "pro",
  "lifetime",
]);
export const entitlementStatus = pgEnum("entitlement_status", ["active", "expired", "revoked"]);
export const agentStatus = pgEnum("agent_status", ["active", "revoked", "expired"]);
export const auditAction = pgEnum("audit_action", [
  "request",
  "authz",
  "verify",
  "policy",
  "dispatch",
  "runner",
  "artifacts",
  "analyze",
  "publish",
  "download",
  "billing",
  "delete",
]);
