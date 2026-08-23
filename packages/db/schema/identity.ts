import { foreignKey, index, pgTable, timestamp, unique } from "drizzle-orm/pg-core";
import { boolean, text, uuid } from "drizzle-orm/pg-core";
import { accountStatus, citext, createdAt, id, identityProvider } from "./common";

export const account = pgTable("account", {
  id: id(),
  status: accountStatus("status").default("active").notNull(),
  settingsIaEnabled: boolean("settings_ia_enabled").default(true).notNull(),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const user = pgTable(
  "user",
  {
    id: id(),
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
    id: id(),
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id").notNull(),
    familyId: uuid("family_id").defaultRandom().notNull(),
    tokenHash: text("token_hash").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    unique("session_token_hash_unique").on(table.tokenHash),
    index("session_family_id_idx").on(table.familyId),
    unique("session_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "session_user_fk",
      columns: [table.userId],
      foreignColumns: [user.id],
    }),
  ],
);
