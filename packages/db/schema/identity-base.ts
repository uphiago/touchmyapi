import { foreignKey, pgTable, timestamp, unique } from "drizzle-orm/pg-core";
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
