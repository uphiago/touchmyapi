import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity";
import { assessment } from "./assessment";
import { agentStatus, createdAt, id, jobStatus } from "./common";

export const job = pgTable(
  "job",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    playbookVersion: text("playbook_version").notNull(),
    jobSpecJson: jsonb("job_spec_json").notNull(),
    status: jobStatus("status").default("queued").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    priority: integer("priority").default(0).notNull(),
    normalizedTargetKey: text("normalized_target_key").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    fencingToken: integer("fencing_token").default(0).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("job_dedupe_key_unique").on(table.dedupeKey),
    unique("job_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "job_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "job_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
    check("job_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check("job_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check("job_fencing_nonnegative", sql`${table.fencingToken} >= 0`),
    uniqueIndex("job_active_target_unique")
      .on(table.accountId, table.normalizedTargetKey)
      .where(sql`${table.status} in ('queued', 'stale_recovered', 'running')`),
  ],
);

export const runnerExecution = pgTable(
  "runner_execution",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    jobId: uuid("job_id").notNull(),
    fencingToken: integer("fencing_token").default(0).notNull(),
    sandboxImpl: text("sandbox_impl").notNull(),
    containerId: text("container_id"),
    imageDigest: text("image_digest"),
    limitsUsedJson: jsonb("limits_used_json"),
    artifactManifestJson: jsonb("artifact_manifest_json"),
    outputManifestJson: jsonb("output_manifest_json"),
    cleanedUp: boolean("cleaned_up").default(false).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("runner_execution_account_id_id_unique").on(table.accountId, table.id),
    unique("runner_execution_job_fence_unique").on(
      table.accountId,
      table.jobId,
      table.fencingToken,
    ),
    foreignKey({
      name: "runner_execution_job_fk",
      columns: [table.accountId, table.jobId],
      foreignColumns: [job.accountId, job.id],
    }),
  ],
);

export const agent = pgTable(
  "agent",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: agentStatus("status").default("active").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("agent_token_hash_unique").on(table.tokenHash),
    unique("agent_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "agent_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);
