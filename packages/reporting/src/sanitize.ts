import { reportExportSchema, type ReportExport } from "@touchmyapi/contracts";

export type ReportPlan = ReportExport["plan"];

export type ReportFindingInput = {
  id: string;
  title: string;
  category: string;
  severity: string;
  evidence?: unknown;
  reproduction?: string[];
  impact?: string;
  remediation?: string;
};

export type ReportSource = Omit<ReportExport, "plan" | "target" | "findings"> & {
  plan?: ReportPlan;
  target: unknown;
  findings: ReportFindingInput[];
};

const SECRET_KEY =
  /(?:secret|token|password|credential|authorization|api[_-]?key|cookie|private[_-]?key)/iu;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PEM = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/u;
const BEARER = /^bearer\s+/iu;
const SENSITIVE_QUERY = /([?&](?:token|secret|password|api[_-]?key|authorization)=)[^&#\s]+/giu;
const REDACTED = "[REDACTED]";

function invalid(): never {
  throw new TypeError("invalid report source");
}

function safeString(value: unknown): string {
  if (typeof value !== "string") invalid();
  if (JWT.test(value) || PEM.test(value) || BEARER.test(value)) return REDACTED;
  return value.replace(SENSITIVE_QUERY, `$1${REDACTED}`);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value === "string") return safeString(value);
  if (typeof value !== "object" || seen.has(value)) invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      result[key] = sanitizeValue(nested, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function sanitizedObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeValue(value, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizedTextList(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) invalid();
  return values.map(safeString);
}

/**
 * The render boundary is deliberately the last place where raw findings are
 * accepted. It strips credential-shaped fields before any JSON/PDF composer.
 * Free plans receive only the public finding summary.
 */
export function sanitizeReport(source: ReportSource, plan = source.plan): ReportExport {
  if (!source || typeof source !== "object" || !plan) invalid();
  const paid = plan === "pro" || plan === "lifetime";
  const aggregate = plan === "free_unverified";
  const findings = aggregate
    ? []
    : [...source.findings]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((finding) => {
          const base = {
            id: finding.id,
            title: safeString(finding.title),
            category: safeString(finding.category),
            severity: safeString(finding.severity),
          };
          if (!paid) return base;
          const result: typeof base & {
            evidence?: Record<string, unknown>;
            reproduction?: string[];
            impact?: string;
            remediation?: string;
          } = { ...base };
          if (finding.evidence !== undefined) result.evidence = sanitizedObject(finding.evidence);
          const reproduction = sanitizedTextList(finding.reproduction);
          if (reproduction !== undefined) result.reproduction = reproduction;
          if (finding.impact !== undefined) result.impact = safeString(finding.impact);
          if (finding.remediation !== undefined)
            result.remediation = safeString(finding.remediation);
          return result;
        });

  return reportExportSchema.parse({
    schemaVersion: "report.json@1",
    assessmentId: source.assessmentId,
    generatedAt: source.generatedAt,
    plan,
    target: sanitizedObject(source.target),
    scope: source.scope,
    playbook: source.playbook,
    methodology: source.methodology.map(safeString),
    limitations: source.limitations.map(safeString),
    findings,
    credits: source.credits,
  });
}
