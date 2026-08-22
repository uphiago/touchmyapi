import { sql } from "drizzle-orm";
import { foreignKey, pgTable, timestamp, unique } from "drizzle-orm/pg-core";
import { boolean, text, uuid } from "drizzle-orm/pg-core";
import { accountStatus, citext, identityProvider } from "./common";

const idColumn = () =>
  uuid("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const account = pgTable(
  "account",
  {
    id: idColumn(),
    status: accountStatus("status").default("active").notNull(),
    settingsIaEnabled: boolean("settings_ia_enabled").default(true).notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [unique("account_id_unique").on(table.id)],
);

export const user = pgTable(
  "user",
  {
    id: idColumn(),
    accountId: uuid("account_id").notNull(),
    provider: identityProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: citext("email"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("user_provider_subject_unique").on(table.provider, table.providerSubject),
    unique("user_account_id_unique").on(table.accountId),
    unique("user_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "user_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);

export const session = pgTable(
  "session",
  {
    id: idColumn(),
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    unique("session_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "session_account_user_fk",
      columns: [table.accountId, table.userId],
      foreignColumns: [user.accountId, user.id],
    }),
  ],
);
