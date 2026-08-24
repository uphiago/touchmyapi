import { boolean, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { targetCategory } from "./common";

/** Finding categories intentionally remain text: the product has no closed vocabulary for them yet. */
export const playbook = pgTable(
  "playbook",
  {
    key: text("key").notNull(),
    playbookVersion: text("playbook_version").notNull(),
    targetCategory: targetCategory("target_category").notNull(),
    contractJson: jsonb("contract_json").notNull(),
    active: boolean("active").default(true).notNull(),
  },
  (table) => [primaryKey({ name: "playbook_pk", columns: [table.key, table.playbookVersion] })],
);
