import {
  artifactManifestSchema,
  redactedObjectSchema,
  type ArtifactManifest,
  type RedactedObject,
} from "@touchmyapi/contracts";
import { appendAuditEvent } from "./audit";
import { getActiveTenantExecutor } from "./tenant-internal";
import type { TenantContext } from "./tenant-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SOURCE_KEY = /^[A-Za-z0-9._:-]{1,255}$/u;

export type ClaimedWorkerJob = Readonly<{
  accountId: string;
  jobId: string;
  assessmentId: string;
  playbookKey: string;
  playbookVersion: string;
  target: string;
  scope: readonly string[];
  limits: Readonly<Record<string, unknown>>;
  contract: Readonly<Record<string, unknown>>;
}>;

export type ClaimedJobRef = Readonly<{
  jobId: string;
  leaseOwner: string;
  fencingToken: number;
}>;

export type RunnerResultInput = ClaimedJobRef &
  Readonly<{
    sandboxImpl: string;
    manifest: ArtifactManifest;
  }>;

export type DeliveryFindingInput = Readonly<{
  sourceKey: string;
  title: string;
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  endpoint: string | null;
  evidence: RedactedObject;
  reproduction: readonly string[];
  impact: string;
  remediation: string;
}>;

export type PublishSucceededJobInput = Readonly<{
  jobId: string;
  fencingToken: number;
  findings: readonly DeliveryFindingInput[];
  reports?: readonly ReportPublicationInput[];
}>;

export type ReportPublicationInput = Readonly<{
  kind: "json" | "pdf_technical" | "pdf_executive";
  objectKey: string;
  contractVersion: string;
}>;

export type SucceededJobRef = Readonly<{
  jobId: string;
  fencingToken: number;
}>;

export type SucceededReportContext = Readonly<{
  assessmentId: string;
  target: string;
  scope: readonly string[];
  playbookKey: string;
  playbookVersion: string;
  plan: "free_unverified" | "free_verified" | "pro" | "lifetime";
  startedAt: string;
  creditsEstimate: number;
  creditsConsumed: number;
}>;

function validateJobRef(input: ClaimedJobRef): void {
  if (!UUID.test(input.jobId)) throw new TypeError("jobId must be a canonical UUID");
  if (!WORKER_ID.test(input.leaseOwner)) throw new TypeError("leaseOwner is invalid");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
}

function decodeObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return Object.freeze({});
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.freeze({ ...(value as Record<string, unknown>) })
    : Object.freeze({});
}

function decodeArray(value: unknown): readonly string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return Object.freeze([]);
    }
  }
  return Array.isArray(value)
    ? Object.freeze(value.filter((item): item is string => typeof item === "string"))
    : Object.freeze([]);
}

export async function readClaimedWorkerJob(
  context: TenantContext<"worker_rls">,
  input: ClaimedJobRef,
): Promise<ClaimedWorkerJob | undefined> {
  validateJobRef(input);
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select job.id as job_id, job.assessment_id, job.playbook_version,
       assessment.playbook_id, assessment.target_json, assessment.scope_json,
       assessment.limits_json, playbook.contract_json
     from public.job as job
     join public.assessment as assessment
       on assessment.account_id = job.account_id and assessment.id = job.assessment_id
     join public.playbook as playbook
       on playbook.key = assessment.playbook_id
      and playbook.playbook_version = assessment.playbook_version
     where job.account_id = $1::uuid and job.id = $2::uuid
       and job.status = 'running'::public.job_status
       and job.lease_owner = $3 and job.fencing_token = $4
       and job.lease_expires_at > clock_timestamp()
     limit 1`,
    [accountId, input.jobId.toLowerCase(), input.leaseOwner, input.fencingToken],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const target = decodeObject(row.target_json).value;
  if (typeof target !== "string" || target.trim() === "") return undefined;
  return Object.freeze({
    accountId,
    jobId: String(row.job_id),
    assessmentId: String(row.assessment_id),
    playbookKey: String(row.playbook_id),
    playbookVersion: String(row.playbook_version),
    target,
    scope: decodeArray(row.scope_json),
    limits: decodeObject(row.limits_json),
    contract: decodeObject(row.contract_json),
  });
}

export async function recordClaimedRunnerResult(
  context: TenantContext<"worker_rls">,
  input: RunnerResultInput,
): Promise<boolean> {
  validateJobRef(input);
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.sandboxImpl)) {
    throw new TypeError("sandboxImpl is invalid");
  }
  const manifest = artifactManifestSchema.parse(input.manifest);
  if (
    manifest.jobId !== input.jobId ||
    !manifest.cleanup.containerRemoved ||
    !manifest.cleanup.tmpfsRemoved
  ) {
    throw new TypeError("runner manifest is not bound and cleaned up");
  }
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `with current_job as (
       select id from public.job
       where account_id = $1::uuid and id = $2::uuid
         and status = 'running'::public.job_status
         and lease_owner = $3 and fencing_token = $4
         and lease_expires_at > clock_timestamp()
       for update
     ), inserted as (
       insert into public.runner_execution (
         account_id, job_id, fencing_token, sandbox_impl, limits_used_json,
         artifact_manifest_json, output_manifest_json, cleaned_up, started_at, finished_at
       )
       select $1::uuid, id, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
         true, clock_timestamp(), $9::timestamptz
       from current_job
       on conflict (account_id, job_id, fencing_token) do nothing
       returning id
     )
     select exists(select 1 from current_job) and (
       exists(select 1 from inserted)
       or exists(
         select 1 from public.runner_execution
         where account_id = $1::uuid and job_id = $2::uuid and fencing_token = $4
       )
     ) as recorded,
     exists(select 1 from inserted) as inserted`,
    [
      accountId,
      input.jobId.toLowerCase(),
      input.leaseOwner,
      input.fencingToken,
      input.sandboxImpl,
      JSON.stringify(manifest.limitsUsed),
      JSON.stringify({ artifacts: manifest.artifacts, stopsTriggered: manifest.stopsTriggered }),
      JSON.stringify(manifest),
      manifest.finishedAt,
    ],
  );
  const result = rows[0] as { recorded?: unknown; inserted?: unknown } | undefined;
  if (result?.recorded !== true) return false;
  if (result.inserted === true) {
    await appendAuditEvent(context, {
      actor: "worker-control",
      action: "runner",
      assessmentId: undefined,
      jobId: input.jobId,
      payload: {
        event: "runner_execution_completed",
        fencingToken: input.fencingToken,
        sandboxImpl: input.sandboxImpl,
        cleanedUp: true,
      },
    });
    await appendAuditEvent(context, {
      actor: "worker-control",
      action: "artifacts",
      jobId: input.jobId,
      payload: {
        event: "artifact_manifest_accepted",
        fencingToken: input.fencingToken,
        artifactCount: manifest.artifacts.length,
        observationCount: manifest.observations?.length ?? 0,
      },
    });
  }
  return true;
}

export async function readSucceededRunnerResult(
  context: TenantContext<"worker_rls">,
  input: SucceededJobRef,
): Promise<ArtifactManifest | undefined> {
  if (!UUID.test(input.jobId)) throw new TypeError("jobId must be a canonical UUID");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select execution.output_manifest_json
     from public.job as job
     join public.runner_execution as execution
       on execution.account_id = job.account_id and execution.job_id = job.id
      and execution.fencing_token = job.fencing_token and execution.cleaned_up = true
     where job.account_id = $1::uuid and job.id = $2::uuid
       and job.status = 'succeeded'::public.job_status and job.fencing_token = $3
     limit 1`,
    [accountId, input.jobId.toLowerCase(), input.fencingToken],
  );
  const raw = (rows[0] as { output_manifest_json?: unknown } | undefined)?.output_manifest_json;
  if (raw === undefined) return undefined;
  return artifactManifestSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}

export async function readSucceededReportContext(
  context: TenantContext<"worker_rls">,
  input: SucceededJobRef,
): Promise<SucceededReportContext | undefined> {
  if (!UUID.test(input.jobId)) throw new TypeError("jobId must be a canonical UUID");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select assessment.id as assessment_id, assessment.target_json, assessment.scope_json,
       assessment.playbook_id, assessment.playbook_version, assessment.created_at,
       assessment.credits_estimate, assessment.credits_consumed,
       coalesce((
         select entitlement.plan::text from public.entitlement
         where entitlement.account_id = assessment.account_id
           and entitlement.status = 'active'::public.entitlement_status
           and (entitlement.expires_at is null or entitlement.expires_at > clock_timestamp())
         order by entitlement.started_at desc, entitlement.id desc limit 1
       ), 'free_unverified') as plan
     from public.job as job
     join public.assessment as assessment
       on assessment.account_id = job.account_id and assessment.id = job.assessment_id
     join public.runner_execution as execution
       on execution.account_id = job.account_id and execution.job_id = job.id
      and execution.fencing_token = job.fencing_token and execution.cleaned_up = true
     where job.account_id = $1::uuid and job.id = $2::uuid
       and job.status = 'succeeded'::public.job_status and job.fencing_token = $3
     limit 1`,
    [accountId, input.jobId.toLowerCase(), input.fencingToken],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const target = decodeObject(row.target_json).value;
  if (typeof target !== "string" || target.trim() === "") return undefined;
  const plan = String(row.plan) as SucceededReportContext["plan"];
  if (!["free_unverified", "free_verified", "pro", "lifetime"].includes(plan)) return undefined;
  return Object.freeze({
    assessmentId: String(row.assessment_id),
    target,
    scope: decodeArray(row.scope_json),
    playbookKey: String(row.playbook_id),
    playbookVersion: String(row.playbook_version),
    plan,
    startedAt: new Date(row.created_at as Date | string).toISOString(),
    creditsEstimate: Number(row.credits_estimate),
    creditsConsumed: Number(row.credits_consumed),
  });
}

function validatedFinding(input: DeliveryFindingInput): DeliveryFindingInput {
  if (!SOURCE_KEY.test(input.sourceKey)) throw new TypeError("finding sourceKey is invalid");
  if (!input.title.trim() || input.title.length > 256)
    throw new TypeError("finding title is invalid");
  if (!input.category.trim() || input.category.length > 128) {
    throw new TypeError("finding category is invalid");
  }
  if (input.endpoint !== null && input.endpoint.length > 2048) {
    throw new TypeError("finding endpoint is invalid");
  }
  if (input.reproduction.length > 20 || input.reproduction.some((step) => step.length > 1024)) {
    throw new TypeError("finding reproduction is invalid");
  }
  if (input.impact.length > 4096 || input.remediation.length > 4096) {
    throw new TypeError("finding copy is invalid");
  }
  return { ...input, evidence: redactedObjectSchema.parse(input.evidence) };
}

export async function publishSucceededJob(
  context: TenantContext<"worker_rls">,
  input: PublishSucceededJobInput,
): Promise<boolean> {
  if (!UUID.test(input.jobId)) throw new TypeError("jobId must be a canonical UUID");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
  if (input.findings.length > 100) throw new RangeError("finding limit exceeded");
  const findings = input.findings.map(validatedFinding);
  const reports = (input.reports ?? []).map((report) => {
    if (
      !["json", "pdf_technical", "pdf_executive"].includes(report.kind) ||
      !/^reports\/[0-9a-f/-]+\/(?:json|pdf_technical|pdf_executive)$/iu.test(report.objectKey) ||
      !report.contractVersion.trim() ||
      report.contractVersion.length > 64
    ) {
      throw new TypeError("report publication is invalid");
    }
    return report;
  });
  const { backend, accountId } = getActiveTenantExecutor(context);
  const jobs = await backend.unsafe(
    `select job.assessment_id
     from public.job as job
     join public.runner_execution as execution
       on execution.account_id = job.account_id and execution.job_id = job.id
      and execution.fencing_token = job.fencing_token and execution.cleaned_up = true
     where job.account_id = $1::uuid and job.id = $2::uuid
       and job.status = 'succeeded'::public.job_status and job.fencing_token = $3
     for update of job`,
    [accountId, input.jobId.toLowerCase(), input.fencingToken],
  );
  const assessmentId = (jobs[0] as { assessment_id?: unknown } | undefined)?.assessment_id;
  if (typeof assessmentId !== "string") return false;

  for (const item of findings) {
    await backend.unsafe(
      `insert into public.finding (
         account_id, assessment_id, source_key, title, category, severity,
         endpoint, evidence_json, repro, impact, remediation, published
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, $6::public.severity,
         $7, $8::jsonb, $9, $10, $11, true
       )
       on conflict (account_id, assessment_id, source_key) do update set
         title = excluded.title, category = excluded.category, severity = excluded.severity,
         endpoint = excluded.endpoint, evidence_json = excluded.evidence_json,
         repro = excluded.repro, impact = excluded.impact,
         remediation = excluded.remediation, published = true`,
      [
        accountId,
        assessmentId,
        item.sourceKey,
        item.title,
        item.category,
        item.severity,
        item.endpoint,
        JSON.stringify(item.evidence),
        JSON.stringify(item.reproduction),
        item.impact,
        item.remediation,
      ],
    );
  }
  for (const report of reports) {
    await backend.unsafe(
      `insert into public.report (
         account_id, assessment_id, kind, object_key, contract_version, sanitized
       ) values ($1::uuid, $2::uuid, $3::public.report_kind, $4, $5, true)
       on conflict (account_id, assessment_id, kind) do update set
         object_key = excluded.object_key, contract_version = excluded.contract_version,
         sanitized = true, generated_at = clock_timestamp()`,
      [accountId, assessmentId, report.kind, report.objectKey, report.contractVersion],
    );
  }
  await backend.unsafe(
    `insert into public.notification (account_id, assessment_id, event_key, kind)
     values ($1::uuid, $2::uuid, $3, 'assessment_completed')
     on conflict (account_id, event_key) do nothing`,
    [accountId, assessmentId, `assessment:${assessmentId}:completed`],
  );
  const updated = await backend.unsafe(
    `update public.assessment
     set status = 'completed'::public.assessment_status,
       failure_reason = null, updated_at = clock_timestamp()
     where account_id = $1::uuid and id = $2::uuid
       and status = 'analyzing'::public.assessment_status
     returning id`,
    [accountId, assessmentId],
  );
  if (updated.length === 1) {
    await appendAuditEvent(context, {
      actor: "worker-control",
      action: "analyze",
      assessmentId,
      jobId: input.jobId,
      payload: {
        event: "passive_analysis_completed",
        fencingToken: input.fencingToken,
        findingCount: findings.length,
        reportCount: reports.length,
      },
    });
    await appendAuditEvent(context, {
      actor: "worker-control",
      action: "publish",
      assessmentId,
      jobId: input.jobId,
      payload: {
        event: "assessment_delivery_published",
        fencingToken: input.fencingToken,
        findingCount: findings.length,
        reportCount: reports.length,
      },
    });
    return true;
  }
  const completed = await backend.unsafe(
    `select id from public.assessment
     where account_id = $1::uuid and id = $2::uuid
       and status = 'completed'::public.assessment_status limit 1`,
    [accountId, assessmentId],
  );
  return completed.length === 1;
}

export async function publishTerminalJob(
  context: TenantContext<"worker_rls">,
  input: SucceededJobRef,
): Promise<boolean> {
  if (!UUID.test(input.jobId)) throw new TypeError("jobId must be a canonical UUID");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `select assessment_id, status
     from public.job
     where account_id = $1::uuid and id = $2::uuid and fencing_token = $3
       and status in ('failed'::public.job_status, 'cancelled'::public.job_status)
     limit 1`,
    [accountId, input.jobId.toLowerCase(), input.fencingToken],
  );
  const row = rows[0] as { assessment_id?: unknown; status?: unknown } | undefined;
  if (typeof row?.assessment_id !== "string") return false;
  if (row.status === "failed") {
    await backend.unsafe(
      `insert into public.notification (account_id, assessment_id, event_key, kind)
       values ($1::uuid, $2::uuid, $3, 'assessment_failed')
       on conflict (account_id, event_key) do nothing`,
      [accountId, row.assessment_id, `assessment:${row.assessment_id}:failed`],
    );
  }
  return true;
}
