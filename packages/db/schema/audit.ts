import { sql } from "drizzle-orm";
import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { account } from "./identity";
import { assessment } from "./assessment";
import { job } from "./execution";
import { auditAction } from "./common";

const idColumn = () =>
  uuid("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey();

export const auditEvent = pgTable(
  "audit_event",
  {
    id: idColumn(),
    accountId: uuid("account_id"),
    assessmentId: uuid("assessment_id"),
    jobId: uuid("job_id"),
    actor: text("actor").notNull(),
    action: auditAction("action").notNull(),
    prevEventId: uuid("prev_event_id"),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
    id: idColumn(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id"),
    kind: text("kind").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
