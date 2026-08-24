import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity";
import { assessment } from "./assessment";
import {
  billingProcessingStatus,
  bytea,
  createdAt,
  entitlementPlan,
  entitlementStatus,
  id,
} from "./common";

export const credential = pgTable(
  "credential",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    encryptedPayload: bytea("encrypted_payload").notNull(),
    keyId: text("key_id").notNull(),
    purpose: text("purpose").notNull(),
    retainedForSchedule: boolean("retained_for_schedule").default(false).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("credential_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "credential_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);

export const billingEvent = pgTable(
  "billing_event",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    stripeEventId: text("stripe_event_id").notNull(),
    type: text("type").notNull(),
    payloadMinimalJson: jsonb("payload_minimal_json").notNull(),
    signatureValid: boolean("signature_valid").default(false).notNull(),
    eventVersion: text("event_version").notNull(),
    apiVersion: text("api_version"),
    processingStatus: billingProcessingStatus("processing_status").default("received").notNull(),
    resultJson: jsonb("result_json"),
    receivedAt: createdAt("received_at"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("billing_event_stripe_event_id_unique").on(table.stripeEventId),
    unique("billing_event_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "billing_event_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);

export const entitlement = pgTable(
  "entitlement",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    plan: entitlementPlan("plan").notNull(),
    status: entitlementStatus("status").default("active").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    startedAt: createdAt("started_at"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("entitlement_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "entitlement_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "entitlement_source_event_fk",
      columns: [table.accountId, table.sourceEventId],
      foreignColumns: [billingEvent.accountId, billingEvent.id],
    }),
  ],
);

export const creditEntry = pgTable(
  "credit_entry",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    assessmentId: uuid("assessment_id"),
    credits: integer("credits").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("credit_entry_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "credit_entry_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "credit_entry_assessment_fk",
      columns: [table.accountId, table.assessmentId],
      foreignColumns: [assessment.accountId, assessment.id],
    }),
  ],
);
