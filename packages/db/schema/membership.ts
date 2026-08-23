import {
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { account, user } from "./identity";
import { citext, createdAt, id, updatedAt } from "./common";

export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "operator",
  "viewer",
  "billing",
]);

export const membershipStatus = pgEnum("membership_status", ["active", "suspended", "removed"]);

export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

export const accountMembership = pgTable(
  "account_membership",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: membershipRole("role").default("viewer").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    invitedByUserId: uuid("invited_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    unique("account_membership_account_user_unique").on(table.accountId, table.userId),
    unique("account_membership_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "account_membership_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "account_membership_user_fk",
      columns: [table.userId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "account_membership_invited_by_user_fk",
      columns: [table.invitedByUserId],
      foreignColumns: [user.id],
    }),
    index("account_membership_account_status_idx").on(table.accountId, table.status),
  ],
);

export const accountInvitation = pgTable(
  "account_invitation",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    email: citext("email").notNull(),
    proposedRole: membershipRole("proposed_role").notNull(),
    status: invitationStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    acceptedByUserId: uuid("accepted_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("account_invitation_token_hash_unique").on(table.tokenHash),
    unique("account_invitation_account_id_id_unique").on(table.accountId, table.id),
    foreignKey({
      name: "account_invitation_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
    foreignKey({
      name: "account_invitation_invited_by_user_fk",
      columns: [table.invitedByUserId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "account_invitation_accepted_by_user_fk",
      columns: [table.acceptedByUserId],
      foreignColumns: [user.id],
    }),
    index("account_invitation_account_status_idx").on(table.accountId, table.status),
  ],
);
