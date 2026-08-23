import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { account } from "./identity-base";

export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "processing",
  "processed",
  "failed",
]);

export const queueGlobalState = pgTable(
  "queue_global_state",
  {
    id: text("id").primaryKey().default("global"),
    runningCount: integer("running_count").default(0).notNull(),
    concurrencyLimit: integer("concurrency_limit").default(8).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("queue_global_state_id_global", sql`${table.id} = 'global'`),
    check("queue_global_state_running_nonnegative", sql`${table.runningCount} >= 0`),
    check("queue_global_state_limit_positive", sql`${table.concurrencyLimit} > 0`),
  ],
);

export const queueTenantState = pgTable(
  "queue_tenant_state",
  {
    accountId: uuid("account_id").primaryKey(),
    lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }),
    runningCount: integer("running_count").default(0).notNull(),
    concurrencyLimit: integer("concurrency_limit").default(2).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("queue_tenant_state_running_nonnegative", sql`${table.runningCount} >= 0`),
    check("queue_tenant_state_limit_positive", sql`${table.concurrencyLimit} > 0`),
    foreignKey({
      name: "queue_tenant_state_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);

export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    accountId: uuid("account_id").notNull(),
    eventKey: text("event_key").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id"),
    schemaVersion: text("schema_version").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    status: outboxStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fencingToken: integer("fencing_token").default(0).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastError: text("last_error"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("outbox_event_key_unique").on(table.eventKey),
    unique("outbox_event_account_id_id_unique").on(table.accountId, table.id),
    index("outbox_event_claim_idx").on(table.availableAt, table.accountId, table.id),
    check("outbox_event_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check("outbox_event_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check("outbox_event_fencing_nonnegative", sql`${table.fencingToken} >= 0`),
    foreignKey({
      name: "outbox_event_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);
