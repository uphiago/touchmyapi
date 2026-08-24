import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  bigint,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity";
import { assessment } from "./assessment";
import { job } from "./execution";
import { auditAction, createdAt, id } from "./common";

export const auditSystemState = pgTable(
  "audit_system_state",
  { id: text("id").primaryKey() },
  (table) => [check("audit_system_state_id_check", sql`${table.id} = 'system'`)],
);

export const auditAccountState = pgTable(
  "audit_account_state",
  {
    accountId: uuid("account_id").primaryKey(),
  },
  (table) => [
    foreignKey({
      name: "audit_account_state_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: id(),
    accountId: uuid("account_id"),
    assessmentId: uuid("assessment_id"),
    jobId: uuid("job_id"),
    actor: text("actor").notNull(),
    action: auditAction("action").notNull(),
    prevEventId: uuid("prev_event_id"),
    chainSeq: bigint("chain_seq", { mode: "number" }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("audit_event_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "audit_event_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "audit_event_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
    foreignKey({
      name: "audit_event_job_fk",
      columns: [table.accountId, table.jobId],
      foreignColumns: [job.accountId, job.id],
    }),
    foreignKey({
      name: "audit_event_prev_fk",
      columns: [table.accountId, table.prevEventId],
      foreignColumns: [table.accountId, table.id],
    }),
  ],
);

export const notification = pgTable(
  "notification",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id"),
    kind: text("kind").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("notification_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "notification_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "notification_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);
