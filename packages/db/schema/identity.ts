import { foreignKey, index, pgTable, timestamp, unique } from "drizzle-orm/pg-core";
import { text, uuid } from "drizzle-orm/pg-core";
import { user } from "./identity-base";
import { accountMembership } from "./membership";
import { id } from "./common";

export { account, user } from "./identity-base";

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
      name: "session_membership_fk",
      columns: [table.accountId, table.userId],
      foreignColumns: [accountMembership.accountId, accountMembership.userId],
    }),
    foreignKey({
      name: "session_user_fk",
      columns: [table.userId],
      foreignColumns: [user.id],
    }),
  ],
);
