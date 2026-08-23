import { randomUUID } from "node:crypto";
import { getActiveTenantExecutor } from "./tenant-internal";
import type { TenantContext } from "./tenant-session";
import { getActiveSystemAuditExecutor, type SystemAuditBackend } from "./system-audit-internal";
import type { SystemAuditContext } from "./system-audit-session";

export type AuditAction =
  | "request"
  | "authz"
  | "verify"
  | "policy"
  | "dispatch"
  | "runner"
  | "artifacts"
  | "analyze"
  | "publish"
  | "download"
  | "billing"
  | "delete";

export type AuditAppendInput = Readonly<{
  actor: string;
  action: AuditAction;
  payload: Record<string, unknown>;
  assessmentId?: string | null;
  jobId?: string | null;
}>;

export type AppendedAuditEvent = Readonly<{
  id: string;
  accountId: string | null;
  prevEventId: string | null;
  createdAt: Date;
}>;

const ACTIONS = new Set<AuditAction>([
  "request",
  "authz",
  "verify",
  "policy",
  "dispatch",
  "runner",
  "artifacts",
  "analyze",
  "publish",
  "download",
  "billing",
  "delete",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY =
  /secret|token|password|credential|authorization|api[_-]?key|cookie|private[_-]?key/i;
const JWT = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const PEM = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/;
const REDACTED = "[REDACTED]";

function invalidInput(): never {
  throw new TypeError("invalid audit input");
}

function redactValue(value: unknown, seen: WeakSet<object>, keySensitive = false): unknown {
  if (keySensitive) return REDACTED;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && (JWT.test(value) || PEM.test(value))) return REDACTED;
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : invalidInput();
  if (typeof value !== "object") invalidInput();
  if (seen.has(value)) invalidInput();
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactValue(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) invalidInput();
    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = redactValue(item, seen, SENSITIVE_KEY.test(key));
    }
    result = object;
  }
  seen.delete(value);
  return result;
}

function normalizeInput(input: AuditAppendInput): {
  actor: string;
  action: AuditAction;
  payload: Record<string, unknown>;
  assessmentId: string | null;
  jobId: string | null;
} {
  if (!input || typeof input !== "object") invalidInput();
  if (typeof input.actor !== "string" || input.actor.trim() === "" || input.actor.length > 256)
    invalidInput();
  if (typeof input.action !== "string" || !ACTIONS.has(input.action as AuditAction)) invalidInput();
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))
    invalidInput();
  if (
    (input.assessmentId !== undefined &&
      input.assessmentId !== null &&
      (typeof input.assessmentId !== "string" || !UUID.test(input.assessmentId))) ||
    (input.jobId !== undefined &&
      input.jobId !== null &&
      (typeof input.jobId !== "string" || !UUID.test(input.jobId)))
  ) {
    invalidInput();
  }
  const payload = redactValue(input.payload, new WeakSet<object>()) as Record<string, unknown>;
  return {
    actor: input.actor,
    action: input.action as AuditAction,
    payload,
    assessmentId: input.assessmentId ?? null,
    jobId: input.jobId ?? null,
  };
}

function appended(row: Record<string, unknown>): AppendedAuditEvent {
  return {
    id: String(row.id),
    accountId: row.account_id === null ? null : String(row.account_id),
    prevEventId: row.prev_event_id === null ? null : String(row.prev_event_id),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

export async function appendAuditEvent(
  context: TenantContext,
  input: AuditAppendInput,
): Promise<AppendedAuditEvent> {
  const executor = getActiveTenantExecutor(context);
  const normalized = normalizeInput(input);
  const accountRows = await executor.backend.unsafe(
    "select id from public.account where id = $1::uuid and status = 'active' and deleted_at is null for update",
    [executor.accountId],
  );
  if (accountRows.length === 0) throw new Error("active tenant account required");
  const tailRows = await executor.backend.unsafe(
    "select id from public.audit_event where account_id = $1::uuid order by created_at desc, id desc limit 1",
    [executor.accountId],
  );
  const id = randomUUID();
  const rows = await executor.backend.unsafe(
    "insert into public.audit_event (id, account_id, assessment_id, job_id, actor, action, prev_event_id, payload_json) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::audit_action, $7::uuid, $8::jsonb) returning id, account_id, prev_event_id, created_at",
    [
      id,
      executor.accountId,
      normalized.assessmentId,
      normalized.jobId,
      normalized.actor,
      normalized.action,
      (tailRows[0] as Record<string, unknown> | undefined)?.id ?? null,
      JSON.stringify(normalized.payload),
    ],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("audit event append failed");
  return appended(row);
}

export async function appendSystemAuditEvent(
  context: SystemAuditContext,
  input: AuditAppendInput,
): Promise<AppendedAuditEvent> {
  const executor = getActiveSystemAuditExecutor(context);
  const normalized = normalizeInput(input);
  if (normalized.assessmentId !== null || normalized.jobId !== null) invalidInput();
  const backend = executor.backend as SystemAuditBackend;
  const stateRows = await backend.unsafe(
    "select id from public.audit_system_state where id = 'system' for update",
  );
  if (stateRows.length === 0) throw new Error("system audit state unavailable");
  const tailRows = await backend.unsafe(
    "select id from public.audit_event where account_id is null order by created_at desc, id desc limit 1",
  );
  const rows = await backend.unsafe(
    "insert into public.audit_event (id, account_id, assessment_id, job_id, actor, action, prev_event_id, payload_json) values ($1::uuid, null, null, null, $2, $3::audit_action, $4::uuid, $5::jsonb) returning id, account_id, prev_event_id, created_at",
    [
      randomUUID(),
      normalized.actor,
      normalized.action,
      (tailRows[0] as Record<string, unknown> | undefined)?.id ?? null,
      JSON.stringify(normalized.payload),
    ],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("system audit event append failed");
  return appended(row);
}
