import { reportExportSchema, type ReportExport } from "@touchmyapi/contracts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

/** Serializes a validated export without timestamps, IDs, or key-order drift. */
export function writeJsonExport(report: ReportExport): Uint8Array {
  const validated = reportExportSchema.parse(report);
  return new TextEncoder().encode(`${JSON.stringify(canonical(validated))}\n`);
}
