import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { assessment } from "./assessment";
import { reportKind, severity } from "./common";

const idColumn = () =>
  uuid("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey();

export const finding = pgTable(
  "finding",
  {
    id: idColumn(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    severity: severity("severity").notNull(),
    endpoint: text("endpoint"),
    evidenceJson: jsonb("evidence_json"),
    repro: text("repro"),
    impact: text("impact"),
    remediation: text("remediation"),
    published: boolean("published").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("finding_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "finding_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);

export const report = pgTable(
  "report",
  {
    id: idColumn(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    kind: reportKind("kind").notNull(),
    objectKey: text("object_key").notNull(),
    contractVersion: text("contract_version").notNull(),
    sanitized: boolean("sanitized").default(false).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("report_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "report_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);
