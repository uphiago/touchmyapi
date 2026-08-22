import { existsSync } from "node:fs";

const required = [
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/db/package.json",
  "tsconfig.json",
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing workspace files: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("workspace files present");
