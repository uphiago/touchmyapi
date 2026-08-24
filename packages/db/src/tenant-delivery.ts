import type { AssessmentState, Notification, ReportMetadata } from "@touchmyapi/contracts";
import { getActiveTenantExecutor } from "./tenant-internal";
import type { TenantContext } from "./tenant-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TenantFinding = Readonly<{
  id: string;
  title: string;
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  endpoint: string | null;
  evidence: Readonly<Record<string, unknown>> | null;
  reproduction: readonly string[];
  impact: string | null;
  remediation: string | null;
}>;

export type TenantAssessmentDelivery = Readonly<{
  assessmentId: string;
  status: AssessmentState;
  findings: readonly TenantFinding[];
}>;

function identifier(value: string, field: string): string {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a canonical UUID`);
  return value.toLowerCase();
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): readonly string[] {
  const decoded = jsonValue(value);
  if (Array.isArray(decoded)) {
    return decoded.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export async function readTenantAssessmentDelivery(
  context: TenantContext<"api_rls">,
  assessmentId: string,
): Promise<TenantAssessmentDelivery | undefined> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const canonicalId = identifier(assessmentId, "assessmentId");
  const assessments = await backend.unsafe(
    `select id, status from public.assessment
     where account_id = $1::uuid and id = $2::uuid limit 1`,
    [accountId, canonicalId],
  );
  const assessment = assessments[0] as Record<string, unknown> | undefined;
  if (!assessment) return undefined;
  const rows = await backend.unsafe(
    `select id, title, category, severity, endpoint, evidence_json, repro, impact, remediation
     from public.finding
     where account_id = $1::uuid and assessment_id = $2::uuid and published = true
     order by
       case severity
         when 'critical'::public.severity then 5
         when 'high'::public.severity then 4
         when 'medium'::public.severity then 3
         when 'low'::public.severity then 2
         else 1
       end desc,
       category, title, id`,
    [accountId, canonicalId],
  );
  return Object.freeze({
    assessmentId: String(assessment.id),
    status: assessment.status as AssessmentState,
    findings: Object.freeze(
      rows.map((row) => {
        const value = row as Record<string, unknown>;
        const evidence = jsonValue(value.evidence_json);
        return Object.freeze({
          id: String(value.id),
          title: String(value.title),
          category: String(value.category),
          severity: value.severity as TenantFinding["severity"],
          endpoint: value.endpoint === null ? null : String(value.endpoint),
          evidence:
            evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
              ? (evidence as Readonly<Record<string, unknown>>)
              : null,
          reproduction: stringArray(value.repro),
          impact: value.impact === null ? null : String(value.impact),
          remediation: value.remediation === null ? null : String(value.remediation),
        });
      }),
    ),
  });
}

function notification(row: Record<string, unknown>): Notification {
  return {
    id: String(row.id),
    assessmentId: row.assessment_id === null ? null : String(row.assessment_id),
    kind: row.kind as Notification["kind"],
    readAt: row.read_at === null ? null : new Date(row.read_at as Date | string).toISOString(),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  };
}

export async function listTenantNotifications(
  context: TenantContext<"api_rls">,
): Promise<readonly Notification[]> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select id, assessment_id, kind, read_at, created_at
     from public.notification where account_id = $1::uuid
     order by created_at desc, id desc limit 100`,
    [accountId],
  );
  return rows.map((row) => notification(row as Record<string, unknown>));
}

export async function markTenantNotificationRead(
  context: TenantContext<"api_rls">,
  notificationId: string,
): Promise<Notification | undefined> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `update public.notification set read_at = coalesce(read_at, clock_timestamp())
     where account_id = $1::uuid and id = $2::uuid
     returning id, assessment_id, kind, read_at, created_at`,
    [accountId, identifier(notificationId, "notificationId")],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? notification(row) : undefined;
}

export async function listTenantReports(
  context: TenantContext<"api_rls">,
  assessmentId: string,
): Promise<readonly ReportMetadata[]> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select id, assessment_id, kind, contract_version, generated_at
     from public.report
     where account_id = $1::uuid and assessment_id = $2::uuid and sanitized = true
     order by generated_at desc, id desc`,
    [accountId, identifier(assessmentId, "assessmentId")],
  );
  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    return {
      id: String(value.id),
      assessmentId: String(value.assessment_id),
      kind: value.kind as ReportMetadata["kind"],
      contractVersion: String(value.contract_version),
      generatedAt: new Date(value.generated_at as Date | string).toISOString(),
    };
  });
}

export async function readTenantReportObjectKey(
  context: TenantContext<"api_rls">,
  assessmentId: string,
  reportId: string,
): Promise<{ objectKey: string; kind: ReportMetadata["kind"] } | undefined> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select object_key, kind
     from public.report
     where account_id = $1::uuid and assessment_id = $2::uuid and id = $3::uuid
       and sanitized = true
     limit 1`,
    [accountId, identifier(assessmentId, "assessmentId"), identifier(reportId, "reportId")],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row
    ? { objectKey: String(row.object_key), kind: row.kind as ReportMetadata["kind"] }
    : undefined;
}
