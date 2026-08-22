import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { assessmentStatus, createdAt, id, targetCategory, updatedAt } from "./common";
import { account, user } from "./identity";
import { agent } from "./execution";
import { verification } from "./verification";
import { playbook } from "./catalog";

export const assessment = pgTable(
  "assessment",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    targetCategory: targetCategory("target_category").notNull(),
    targetJson: jsonb("target_json").notNull(),
    scopeJson: jsonb("scope_json").notNull(),
    playbookId: text("playbook_id").notNull(),
    playbookVersion: text("playbook_version").notNull(),
    limitsJson: jsonb("limits_json").notNull(),
    status: assessmentStatus("status").default("draft").notNull(),
    failureReason: text("failure_reason"),
    verificationRef: uuid("verification_ref"),
    creditsEstimate: integer("credits_estimate").default(0).notNull(),
    creditsConsumed: integer("credits_consumed").default(0).notNull(),
    agentId: uuid("agent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("assessment_account_id_id_unique").on(table.accountId, table.id),
    check("assessment_credits_estimate_nonnegative", sql`${table.creditsEstimate} >= 0`),
    check("assessment_credits_consumed_nonnegative", sql`${table.creditsConsumed} >= 0`),
    foreignKey({
      name: "assessment_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "assessment_verification_fk",
      columns: [table.accountId, table.verificationRef],
      foreignColumns: [verification.accountId, verification.id],
    }),
    foreignKey({
      name: "assessment_agent_fk",
      columns: [table.accountId, table.agentId],
      foreignColumns: [agent.accountId, agent.id],
    }),
    foreignKey({
      name: "assessment_playbook_fk",
      columns: [table.playbookId, table.playbookVersion],
      foreignColumns: [playbook.key, playbook.playbookVersion],
    }),
  ],
);

export const authorizationAttestation = pgTable(
  "authorization_attestation",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    userId: uuid("user_id").notNull(),
    targetJson: jsonb("target_json").notNull(),
    termsVersion: text("terms_version").notNull(),
    acceptedAt: createdAt("accepted_at"),
  },
  (table) => [
    unique("authorization_attestation_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "authorization_attestation_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
    foreignKey({
      name: "authorization_attestation_user_fk",
      columns: [table.accountId, table.userId],
      foreignColumns: [user.accountId, user.id],
    }),
  ],
);
