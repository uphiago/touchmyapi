import { sql } from "drizzle-orm";
import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { verificationMethod, verificationStatus } from "./common";
import { account } from "./identity";

export const verification = pgTable(
  "verification",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    accountId: uuid("account_id").notNull(),
    targetJson: jsonb("target_json").notNull(),
    method: verificationMethod("method").default("http_file").notNull(),
    challengeToken: text("challenge_token").notNull(),
    challengeHost: text("challenge_host"),
    status: verificationStatus("status").default("pending").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    fetchEvidence: jsonb("fetch_evidence"),
  },
  (table) => [
    unique("verification_account_id_id_unique").on(table.accountId, table.id),
    unique("verification_challenge_token_unique").on(table.challengeToken),
    foreignKey({
      name: "verification_account_fk",
      columns: [table.accountId],
      foreignColumns: [account.id],
    }),
  ],
);
