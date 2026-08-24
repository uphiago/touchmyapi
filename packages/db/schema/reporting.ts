import { boolean, foreignKey, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { assessment } from "./assessment";
import { createdAt, id, reportKind, severity } from "./common";

export const finding = pgTable(
  "finding",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    sourceKey: text("source_key").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    severity: severity("severity").notNull(),
    endpoint: text("endpoint"),
    evidenceJson: jsonb("evidence_json"),
    repro: text("repro"),
    impact: text("impact"),
    remediation: text("remediation"),
    published: boolean("published").default(false).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("finding_account_id_id_unique").on(table.accountId, table.id),
    unique("finding_assessment_source_unique").on(
      table.accountId,
      table.assessmentId,
      table.sourceKey,
    ),
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
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    kind: reportKind("kind").notNull(),
    objectKey: text("object_key").notNull(),
    contractVersion: text("contract_version").notNull(),
    sanitized: boolean("sanitized").default(false).notNull(),
    generatedAt: createdAt("generated_at"),
  },
  (table) => [
    unique("report_account_id_id_unique").on(table.accountId, table.id),
    unique("report_assessment_kind_unique").on(table.accountId, table.assessmentId, table.kind),
    foreignKey({
      name: "report_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);
