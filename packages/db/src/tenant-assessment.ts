import {
  assessmentCreateSchema,
  assessmentSchema,
  type Assessment,
  type AssessmentCreate,
} from "@touchmyapi/contracts";
import { getActiveTenantExecutor } from "./tenant-internal";
import type { TenantContext } from "./tenant-session";

export type CreateAssessmentInput = Readonly<{
  userId: string;
  request: AssessmentCreate;
}>;

export type QueueAssessmentInput = Readonly<{ assessmentId: string }>;

export type AssessmentPolicySnapshot = Readonly<{
  assessment: Assessment;
  attestedByUserId: string;
  termsVersion: string;
  acceptedAt: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function mapAssessment(row: Record<string, unknown> | undefined): Assessment | undefined {
  if (!row) return undefined;
  const targetJson = decodeJson(row.target_json) as { value?: unknown } | undefined;
  const scopeJson = decodeJson(row.scope_json);
  return assessmentSchema.parse({
    id: String(row.id),
    accountId: String(row.account_id),
    targetCategory: row.target_category,
    target: String(targetJson?.value ?? ""),
    scope: Array.isArray(scopeJson) ? scopeJson : [],
    playbookId: String(row.playbook_id),
    playbookVersion: String(row.playbook_version),
    status: row.status,
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  });
}

const assessmentSelect = `
  select assessment.id, assessment.account_id, assessment.target_category,
    assessment.target_json, assessment.scope_json, assessment.playbook_id,
    assessment.playbook_version, assessment.status, assessment.created_at,
    assessment.updated_at, null::uuid as job_id
  from public.assessment as assessment
`;

export async function listAssessments(
  context: TenantContext<"api_rls">,
): Promise<readonly Assessment[]> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  const rows = await backend.unsafe(
    `${assessmentSelect} where assessment.account_id = $1::uuid
     order by assessment.created_at desc, assessment.id desc`,
    [accountId],
  );
  return rows.map((row) => mapAssessment(row as Record<string, unknown>)!);
}

export async function createAssessment(
  context: TenantContext<"api_rls">,
  input: CreateAssessmentInput,
): Promise<Assessment> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  if (!UUID.test(input.userId)) throw new TypeError("userId must be a canonical UUID");
  const request = assessmentCreateSchema.parse(input.request);
  if (request.targetCategory !== "surface" || request.playbookId !== "surface-public-posture") {
    throw new TypeError("only the passive surface playbook is available");
  }
  const playbooks = await backend.unsafe(
    `select playbook_version, contract_json from public.playbook
     where key = $1 and target_category = $2::public.target_category and active = true
     order by playbook_version desc limit 1`,
    [request.playbookId, request.targetCategory],
  );
  const playbook = playbooks[0] as Record<string, unknown> | undefined;
  if (!playbook || playbook.playbook_version !== "1.0.0") {
    throw new Error("passive playbook unavailable");
  }
  const limits = (playbook.contract_json as { limits?: unknown } | undefined)?.limits ?? {
    maxDurationS: 300,
    maxConcurrency: 1,
    maxRatePerMin: 10,
  };
  const rows = await backend.unsafe(
    `with created as (
       insert into public.assessment (
         account_id, target_category, target_json, scope_json, playbook_id,
         playbook_version, limits_json, status
       ) values (
         $1::uuid, $2::public.target_category, $3::jsonb, $4::jsonb, $5,
         $6, $7::jsonb, 'draft'::public.assessment_status
       ) returning *
     ), attested as (
       insert into public.authorization_attestation (
         account_id, assessment_id, user_id, target_json, terms_version
       ) select account_id, id, $8::uuid, target_json, $9 from created
       returning assessment_id
     )
     select created.id, created.account_id, created.target_category,
       created.target_json, created.scope_json, created.playbook_id,
       created.playbook_version, created.status, created.created_at,
       created.updated_at, null::uuid as job_id
     from created join attested on attested.assessment_id = created.id`,
    [
      accountId,
      request.targetCategory,
      JSON.stringify({ value: request.target }),
      JSON.stringify(request.scope),
      request.playbookId,
      String(playbook.playbook_version),
      JSON.stringify(limits),
      input.userId.toLowerCase(),
      request.authorization.termsVersion,
    ],
  );
  const created = mapAssessment(rows[0] as Record<string, unknown> | undefined);
  if (!created) throw new Error("assessment creation failed");
  return created;
}

export async function readAssessmentPolicySnapshot(
  context: TenantContext<"api_rls">,
  assessmentId: string,
): Promise<AssessmentPolicySnapshot | undefined> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  if (!UUID.test(assessmentId)) throw new TypeError("assessmentId must be a canonical UUID");
  const rows = await backend.unsafe(
    `select assessment.id, assessment.account_id, assessment.target_category,
       assessment.target_json, assessment.scope_json, assessment.playbook_id,
       assessment.playbook_version, assessment.status, assessment.created_at,
       assessment.updated_at, null::uuid as job_id,
       attestation.user_id as attested_by_user_id,
       attestation.terms_version, attestation.accepted_at
     from public.assessment as assessment
     join public.authorization_attestation as attestation
       on attestation.account_id = assessment.account_id
      and attestation.assessment_id = assessment.id
     where assessment.account_id = $1::uuid and assessment.id = $2::uuid
     order by attestation.accepted_at desc, attestation.id desc limit 1`,
    [accountId, assessmentId.toLowerCase()],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const assessment = mapAssessment(row);
  if (!row || !assessment) return undefined;
  return Object.freeze({
    assessment,
    attestedByUserId: String(row.attested_by_user_id),
    termsVersion: String(row.terms_version),
    acceptedAt: new Date(row.accepted_at as string | Date).toISOString(),
  });
}

export async function queueAssessment(
  context: TenantContext<"api_rls">,
  input: QueueAssessmentInput,
): Promise<Assessment | undefined> {
  const { backend, accountId } = getActiveTenantExecutor(context);
  if (!UUID.test(input.assessmentId)) throw new TypeError("assessmentId must be a canonical UUID");
  const rows = await backend.unsafe(
    `select assessment.target_json
     from public.assessment as assessment
     where assessment.account_id = $1::uuid and assessment.id = $2::uuid
       and assessment.target_category = 'surface'::public.target_category
       and assessment.playbook_id = 'surface-public-posture'
       and assessment.playbook_version = '1.0.0'
       and assessment.status = 'draft'::public.assessment_status
       and exists (
         select 1 from public.authorization_attestation as attestation
         where attestation.account_id = assessment.account_id
           and attestation.assessment_id = assessment.id
           and attestation.terms_version = 'terms@1'
       )
     for update`,
    [accountId, input.assessmentId.toLowerCase()],
  );
  const targetJson = decodeJson((rows[0] as { target_json?: unknown } | undefined)?.target_json) as
    { value?: unknown } | undefined;
  const target = targetJson?.value;
  if (typeof target !== "string" || target.trim() === "") return undefined;
  const normalizedTargetKey = target
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .split("/")[0];
  const queued = await backend.unsafe(
    `select app_private.queue_enqueue($1::uuid, $2::uuid, $3, now(), 0, 3) as job_id`,
    [accountId, input.assessmentId.toLowerCase(), normalizedTargetKey],
  );
  if (!(queued[0] as { job_id?: unknown } | undefined)?.job_id) return undefined;
  const refreshed = await backend.unsafe(
    `${assessmentSelect} where assessment.account_id = $1::uuid and assessment.id = $2::uuid`,
    [accountId, input.assessmentId.toLowerCase()],
  );
  const assessment = mapAssessment(refreshed[0] as Record<string, unknown> | undefined);
  return assessment
    ? { ...assessment, jobId: String((queued[0] as { job_id: unknown }).job_id) }
    : undefined;
}
