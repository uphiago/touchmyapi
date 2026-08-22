import { createHash } from "node:crypto";
import {
  isCompiledScope,
  matchesScope,
  normalizeExternalUrl,
  validateResolvedAddresses,
  type CompiledScope,
  type NormalizedTarget,
} from "./scope";
import { isPlan, rightsForPlan, type Plan } from "./entitlement";
import { reduceLimits, type EffectiveLimits, type LimitInput } from "./limits";

/** Runtime actions accepted by the policy boundary. Unknown strings are denied. */
export type RuntimeAction = "passive_external" | "active_external";
export type TargetCategory = "web" | "api" | "surface" | "genai" | "internal";

export type BlockCode =
  | "unknown_action"
  | "unknown_target_category"
  | "target_category_not_allowed"
  | "target_category_mismatch"
  | "unknown_plan"
  | "invalid_entitlement"
  | "entitlement_expired"
  | "invalid_context"
  | "scope_required"
  | "target_invalid"
  | "target_out_of_scope"
  | "resolved_addresses_required"
  | "forbidden_target"
  | "port_not_allowed"
  | "attestation_required"
  | "invalid_attestation"
  | "attestation_context_mismatch"
  | "verification_required"
  | "verification_method_not_allowed"
  | "verification_not_verified"
  | "verification_context_mismatch"
  | "verification_expired"
  | "playbook_required"
  | "invalid_playbook"
  | "unknown_playbook_action"
  | "capability_not_allowed"
  | "plan_action_not_allowed"
  | "invalid_limits"
  | "invalid_egress"
  | "caller_execution_fields_not_allowed";

export type PolicyBlock = Readonly<{ code: BlockCode }>;

export type AuthorizedAction = Readonly<{
  id: string;
  type: string;
  capability: string;
  allowedTargets: "scope";
  method?: "GET";
  limit: Readonly<{ requests: number; durationS: number }>;
}>;

export type ActionRequest = Readonly<{
  context: PolicyContext;
  action: string;
  targetCategory: string;
  /** A URL string, or a target descriptor containing a candidate URL and DNS facts. */
  target: unknown;
  scope: CompiledScope;
  entitlement: PolicyEntitlement;
  limits: LimitInput;
  attestation: unknown;
  verification: unknown;
  playbook: unknown;
  readonly [key: string]: unknown;
}>;

export type PolicyDecision = Readonly<{
  allowed: boolean;
  blocked: readonly PolicyBlock[];
  reason: string;
  actions: readonly AuthorizedAction[];
  capabilities: readonly string[];
  limits: EffectiveLimits | null;
  target: NormalizedTarget | null;
  resolvedAddresses: readonly string[];
  scopeFingerprint: string | null;
}>;

type RecordValue = Record<string, unknown>;
type Snapshot = { ok: true; value: RecordValue; keys: readonly string[] } | { ok: false };

const TARGET_CATEGORIES = new Set<TargetCategory>(["web", "api", "surface", "genai", "internal"]);
const ACTIONS = new Set<RuntimeAction>(["passive_external", "active_external"]);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;
const STRIPE_EVENT = /^evt_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const policyContextSet = new WeakSet<object>();
const policyEntitlementSet = new WeakSet<object>();
const policyEntitlementAccount = new WeakMap<object, string>();

const ACTION_MAP = Object.freeze({
  "dns.records": Object.freeze({ type: "dns_lookup", capability: "dns_resolver" }),
  "tls.cert": Object.freeze({ type: "tls_probe", capability: "tls_probe" }),
  "http.headers": Object.freeze({ type: "http_probe", capability: "http_client" }),
  "robots.txt": Object.freeze({ type: "robots_fetch", capability: "http_client" }),
  "sitemap.xml": Object.freeze({ type: "sitemap_fetch", capability: "http_client" }),
  "endpoint.minimal": Object.freeze({ type: "endpoint_probe", capability: "http_client" }),
} as const);
type ActionId = keyof typeof ACTION_MAP;

const CANONICAL_ACTIONS = Object.freeze([
  Object.freeze({
    id: "dns.records",
    type: "dns_lookup",
    allowedTargets: "scope",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
  Object.freeze({
    id: "tls.cert",
    type: "tls_probe",
    allowedTargets: "scope",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
  Object.freeze({
    id: "http.headers",
    type: "http_probe",
    allowedTargets: "scope",
    method: "GET",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
  Object.freeze({
    id: "robots.txt",
    type: "robots_fetch",
    allowedTargets: "scope",
    method: "GET",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
  Object.freeze({
    id: "sitemap.xml",
    type: "sitemap_fetch",
    allowedTargets: "scope",
    method: "GET",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
  Object.freeze({
    id: "endpoint.minimal",
    type: "endpoint_probe",
    allowedTargets: "scope",
    method: "GET",
    limit: Object.freeze({ requests: 1, durationS: 30 }),
  }),
] as const);
const CANONICAL_STOP_SIGNALS = Object.freeze([
  "scope_escape",
  "rate_exceeded",
  "unauthorized_endpoint",
  "duration_exceeded",
] as const);
const CANONICAL_PRECONDITIONS = Object.freeze([
  { kind: "http_verification_required", when: "active_external" },
] as const);
const CANONICAL_IMPACT_LEVELS = Object.freeze(["low"] as const);
const CANONICAL_EVIDENCE = Object.freeze({
  expected: Object.freeze(["public_posture"] as const),
  format: "manifest" as const,
});
const CANONICAL_SEVERITY = Object.freeze(["info", "low"] as const);

function snapshotObject(input: unknown, allowedKeys?: readonly string[]): Snapshot {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false };
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const values = Object.create(null) as RecordValue;
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") return { ok: false };
      keys.push(key);
      if (allowedKeys && !allowedKeys.includes(key)) return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return { ok: false };
      if (Reflect.get(input, key) !== descriptor.value) return { ok: false };
      values[key] = descriptor.value;
    }
    return { ok: true, value: values, keys };
  } catch {
    return { ok: false };
  }
}

function snapshotArray(input: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const keys = Reflect.ownKeys(input);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value)
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    if (length < 0 || keys.length !== length + 1) return null;
    if (Reflect.get(input, "length") !== length) return null;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return null;
      if (Reflect.get(input, key) !== descriptor.value) return null;
      values.push(descriptor.value);
    }
    if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key))))
      return null;
    return values;
  } catch {
    return null;
  }
}

function isOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor && "value" in descriptor) freezeDeep(descriptor.value);
  }
  return Object.freeze(value);
}

function denied(blocked: readonly BlockCode[]): PolicyDecision {
  const unique: PolicyBlock[] = [];
  for (const code of blocked) {
    if (!unique.some((block) => block.code === code)) unique.push(Object.freeze({ code }));
  }
  return freezeDeep({
    allowed: false,
    blocked: unique,
    reason: "assessment blocked by policy",
    actions: [],
    capabilities: [],
    limits: null,
    target: null,
    resolvedAddresses: [],
    scopeFingerprint: null,
  });
}

function allowed(
  actions: readonly AuthorizedAction[],
  capabilities: readonly string[],
  limits: EffectiveLimits,
  target: NormalizedTarget,
  resolvedAddresses: readonly string[],
  scopeFingerprint: string,
): PolicyDecision {
  return freezeDeep({
    allowed: true,
    blocked: [],
    reason: "allowed",
    actions: actions.map((action) =>
      Object.freeze({
        ...action,
        limit: Object.freeze({ ...action.limit }),
      }),
    ),
    capabilities: [...capabilities],
    limits,
    target,
    resolvedAddresses: [...resolvedAddresses],
    scopeFingerprint,
  });
}

export type PolicyContext = Readonly<{
  accountId: string;
  assessmentId: string;
  userId: string;
  evaluatedAt: string;
  scopeFingerprint: string;
}>;

export type PolicyEntitlement = Readonly<{
  plan: Plan;
  source: "baseline" | "http_verification" | "stripe_webhook";
  sourceId: string | null;
  grantedAt: string;
  expiresAt: string | null;
}>;

/** Compute the server-owned SHA-256 fingerprint of an authentic compiled scope. */
export function fingerprintScope(scope: CompiledScope): string {
  if (!isCompiledScope(scope)) throw new TypeError("invalid compiled scope");
  const canonical = JSON.stringify({
    inclusions: scope.inclusions.map((rule) => ({
      host: rule.host,
      port: rule.port,
      pathPrefix: rule.pathPrefix,
      wildcard: rule.wildcard,
    })),
    exclusions: scope.exclusions.map((rule) => ({
      host: rule.host,
      port: rule.port,
      pathPrefix: rule.pathPrefix,
      wildcard: rule.wildcard,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Build an opaque policy context from server-supplied identity/time facts.
 * The API must supply an authoritative server/DB timestamp; this factory never reads a clock.
 */
export function createPolicyContext(input: unknown, scope: CompiledScope): PolicyContext {
  if (!isCompiledScope(scope)) throw new TypeError("invalid compiled scope");
  const snapshot = snapshotObject(input, ["accountId", "assessmentId", "userId", "evaluatedAt"]);
  if (
    !snapshot.ok ||
    !exactKeys(snapshot, ["accountId", "assessmentId", "userId", "evaluatedAt"]) ||
    typeof snapshot.value.accountId !== "string" ||
    !UUID.test(snapshot.value.accountId) ||
    typeof snapshot.value.assessmentId !== "string" ||
    !UUID.test(snapshot.value.assessmentId) ||
    typeof snapshot.value.userId !== "string" ||
    !UUID.test(snapshot.value.userId) ||
    !validUtc(snapshot.value.evaluatedAt)
  )
    throw new TypeError("invalid policy context");
  const context = Object.freeze({
    accountId: snapshot.value.accountId,
    assessmentId: snapshot.value.assessmentId,
    userId: snapshot.value.userId,
    evaluatedAt: snapshot.value.evaluatedAt,
    scopeFingerprint: fingerprintScope(scope),
  });
  policyContextSet.add(context);
  return context;
}

/**
 * Build an opaque entitlement from server-side state only.
 * The API must pass a DB/webhook/verification row; request fields are never entitlement facts.
 */
export function createPolicyEntitlement(input: unknown, context: PolicyContext): PolicyEntitlement {
  if (!isPolicyContext(context)) throw new TypeError("invalid policy context");
  const keys = ["plan", "source", "sourceId", "grantedAt", "expiresAt"] as const;
  const snapshot = snapshotObject(input, keys);
  if (!snapshot.ok || !exactKeys(snapshot, keys)) throw new TypeError("invalid entitlement");
  const value = snapshot.value;
  if (
    !isPlan(value.plan) ||
    (value.source !== "baseline" &&
      value.source !== "http_verification" &&
      value.source !== "stripe_webhook") ||
    (value.sourceId !== null && typeof value.sourceId !== "string") ||
    !validUtc(value.grantedAt) ||
    (value.expiresAt !== null && !validUtc(value.expiresAt))
  )
    throw new TypeError("invalid entitlement");
  const grantedAt = Date.parse(value.grantedAt);
  const evaluatedAt = Date.parse(context.evaluatedAt);
  const expiresAt = value.expiresAt === null ? null : Date.parse(value.expiresAt);
  if (grantedAt > evaluatedAt || (expiresAt !== null && expiresAt <= grantedAt))
    throw new TypeError("invalid entitlement");
  if (
    value.plan === "free_unverified" &&
    (value.source !== "baseline" || value.sourceId !== null || value.expiresAt !== null)
  )
    throw new TypeError("invalid entitlement");
  if (
    value.plan === "free_verified" &&
    (value.source !== "http_verification" ||
      value.sourceId === null ||
      !UUID.test(value.sourceId) ||
      expiresAt === null ||
      expiresAt <= evaluatedAt)
  )
    throw new TypeError("invalid entitlement");
  if (
    (value.plan === "pro" || value.plan === "lifetime") &&
    (value.source !== "stripe_webhook" ||
      value.sourceId === null ||
      !STRIPE_EVENT.test(value.sourceId))
  )
    throw new TypeError("invalid entitlement");
  if (value.plan === "pro" && (expiresAt === null || expiresAt <= evaluatedAt))
    throw new TypeError("invalid entitlement");
  if (value.plan === "lifetime" && value.expiresAt !== null)
    throw new TypeError("invalid entitlement");
  const entitlement = Object.freeze({
    plan: value.plan,
    source: value.source,
    sourceId: value.sourceId,
    grantedAt: value.grantedAt,
    expiresAt: value.expiresAt,
  }) as PolicyEntitlement;
  policyEntitlementSet.add(entitlement);
  policyEntitlementAccount.set(entitlement, context.accountId);
  return entitlement;
}

function validUtc(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

function isPolicyContext(input: unknown): input is PolicyContext {
  return typeof input === "object" && input !== null && policyContextSet.has(input);
}

function parseEntitlement(
  input: unknown,
  context: PolicyContext | undefined,
): { plan?: Plan; code?: BlockCode } {
  if (
    typeof input !== "object" ||
    input === null ||
    !policyEntitlementSet.has(input) ||
    !context ||
    policyEntitlementAccount.get(input) !== context.accountId
  ) {
    return { code: "invalid_entitlement" };
  }
  const keys = ["plan", "source", "sourceId", "grantedAt", "expiresAt"] as const;
  const snapshot = snapshotObject(input, keys);
  if (!snapshot.ok || !exactKeys(snapshot, keys)) return { code: "invalid_entitlement" };
  const value = snapshot.value;
  if (
    !isPlan(value.plan) ||
    (value.source !== "baseline" &&
      value.source !== "http_verification" &&
      value.source !== "stripe_webhook") ||
    (value.sourceId !== null && typeof value.sourceId !== "string") ||
    !validUtc(value.grantedAt) ||
    (value.expiresAt !== null && !validUtc(value.expiresAt))
  )
    return { code: "invalid_entitlement" };
  const evaluatedAt = Date.parse(context.evaluatedAt);
  const grantedAt = Date.parse(value.grantedAt);
  const expiresAt = value.expiresAt === null ? null : Date.parse(value.expiresAt);
  if (grantedAt > evaluatedAt) return { code: "invalid_entitlement" };
  if (expiresAt !== null && expiresAt <= evaluatedAt) return { code: "entitlement_expired" };
  if (
    value.plan === "free_unverified" &&
    (value.source !== "baseline" || value.sourceId !== null || value.expiresAt !== null)
  )
    return { code: "invalid_entitlement" };
  if (
    value.plan === "free_verified" &&
    (value.source !== "http_verification" || value.sourceId === null || !UUID.test(value.sourceId))
  )
    return { code: "invalid_entitlement" };
  if (
    (value.plan === "pro" || value.plan === "lifetime") &&
    (value.source !== "stripe_webhook" ||
      value.sourceId === null ||
      !STRIPE_EVENT.test(value.sourceId))
  )
    return { code: "invalid_entitlement" };
  if (value.plan === "pro" && expiresAt === null) return { code: "invalid_entitlement" };
  if (value.plan === "lifetime" && value.expiresAt !== null) return { code: "invalid_entitlement" };
  return { plan: value.plan };
}

function parseContext(input: unknown): { value?: PolicyContext; code?: BlockCode } {
  if (typeof input !== "object" || input === null || !policyContextSet.has(input)) {
    return { code: "invalid_context" };
  }
  const snapshot = snapshotObject(input, [
    "accountId",
    "assessmentId",
    "userId",
    "evaluatedAt",
    "scopeFingerprint",
  ]);
  if (
    !snapshot.ok ||
    !exactKeys(snapshot, ["accountId", "assessmentId", "userId", "evaluatedAt", "scopeFingerprint"])
  ) {
    return { code: "invalid_context" };
  }
  const value = snapshot.value;
  if (
    typeof value.accountId !== "string" ||
    !UUID.test(value.accountId) ||
    typeof value.assessmentId !== "string" ||
    !UUID.test(value.assessmentId) ||
    typeof value.userId !== "string" ||
    !UUID.test(value.userId) ||
    !validUtc(value.evaluatedAt) ||
    typeof value.scopeFingerprint !== "string" ||
    !FINGERPRINT.test(value.scopeFingerprint)
  )
    return { code: "invalid_context" };
  return { value: input as PolicyContext };
}

function parseTarget(root: RecordValue): {
  candidate: string | undefined;
  addresses: readonly string[] | undefined;
  malformed: boolean;
} {
  const targetSnapshot = snapshotObject(root.target, ["candidate", "resolvedAddresses"]);
  if (!targetSnapshot.ok || !exactKeys(targetSnapshot, ["candidate", "resolvedAddresses"])) {
    return { candidate: undefined, addresses: undefined, malformed: true };
  }
  const candidate = targetSnapshot.value.candidate;
  const addressSnapshot = snapshotArray(targetSnapshot.value.resolvedAddresses);
  return {
    candidate: typeof candidate === "string" ? candidate : undefined,
    addresses:
      addressSnapshot && addressSnapshot.every((address) => typeof address === "string")
        ? (addressSnapshot as readonly string[])
        : undefined,
    malformed:
      typeof candidate !== "string" ||
      addressSnapshot === null ||
      addressSnapshot.some((address) => typeof address !== "string"),
  };
}

function parseScope(root: RecordValue): {
  scope: unknown;
  candidate: string | undefined;
  addresses: readonly string[] | undefined;
  malformed: boolean;
} {
  const raw = root.scope;
  if (raw === null || typeof raw !== "object") {
    return { scope: undefined, candidate: undefined, addresses: undefined, malformed: true };
  }
  return { scope: raw, candidate: undefined, addresses: undefined, malformed: false };
}

function targetOrigin(target: NormalizedTarget): string {
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  const hostname = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  return `${target.protocol}//${hostname}${target.port === defaultPort ? "" : `:${target.port}`}`;
}

type FactState =
  "none" | "invalid" | "mismatch" | "expired" | "unverified" | "ok" | "method_not_allowed";

function parseVerification(
  input: unknown,
  context: PolicyContext | undefined,
  target: NormalizedTarget | undefined,
): FactState {
  if (input === null || input === undefined) return "none";
  const methodProbe = snapshotObject(input);
  if (methodProbe.ok && methodProbe.value.method === "dns_txt") return "method_not_allowed";
  const snapshot = snapshotObject(input, [
    "method",
    "status",
    "accountId",
    "assessmentId",
    "targetOrigin",
    "scopeFingerprint",
    "challengeId",
    "verifiedAt",
    "expiresAt",
  ]);
  const keys = [
    "method",
    "status",
    "accountId",
    "assessmentId",
    "targetOrigin",
    "scopeFingerprint",
    "challengeId",
    "verifiedAt",
    "expiresAt",
  ];
  if (!snapshot.ok || !exactKeys(snapshot, keys)) return "invalid";
  const value = snapshot.value;
  if (
    value.method !== "http_file" ||
    (value.status !== "pending" && value.status !== "verified" && value.status !== "expired") ||
    typeof value.accountId !== "string" ||
    !UUID.test(value.accountId) ||
    typeof value.assessmentId !== "string" ||
    !UUID.test(value.assessmentId) ||
    typeof value.targetOrigin !== "string" ||
    typeof value.scopeFingerprint !== "string" ||
    !FINGERPRINT.test(value.scopeFingerprint) ||
    typeof value.challengeId !== "string" ||
    !UUID.test(value.challengeId) ||
    !validUtc(value.verifiedAt) ||
    !validUtc(value.expiresAt) ||
    !context ||
    !target
  )
    return "invalid";
  if (
    value.accountId !== context.accountId ||
    value.assessmentId !== context.assessmentId ||
    value.scopeFingerprint !== context.scopeFingerprint ||
    value.targetOrigin !== targetOrigin(target)
  )
    return "mismatch";
  const evaluated = Date.parse(context.evaluatedAt);
  const verified = Date.parse(value.verifiedAt);
  const expires = Date.parse(value.expiresAt);
  if (verified > evaluated) return "unverified";
  if (expires <= evaluated || expires <= verified || value.status === "expired") return "expired";
  if (value.status !== "verified") return "unverified";
  return "ok";
}

function parseAttestation(
  input: unknown,
  context: PolicyContext | undefined,
  target: NormalizedTarget | undefined,
  playbook: ParsedPlaybook | undefined,
): "required" | "invalid" | "mismatch" | "ok" {
  if (input === null || input === undefined) return "required";
  const keys = [
    "version",
    "accountId",
    "assessmentId",
    "userId",
    "target",
    "scopeFingerprint",
    "playbookKey",
    "playbookVersion",
    "acceptedAt",
  ];
  const snapshot = snapshotObject(input, keys);
  if (!snapshot.ok || !exactKeys(snapshot, keys)) return "invalid";
  const value = snapshot.value;
  if (
    value.version !== "terms@1" ||
    typeof value.accountId !== "string" ||
    !UUID.test(value.accountId) ||
    typeof value.assessmentId !== "string" ||
    !UUID.test(value.assessmentId) ||
    typeof value.userId !== "string" ||
    !UUID.test(value.userId) ||
    typeof value.target !== "string" ||
    typeof value.scopeFingerprint !== "string" ||
    !FINGERPRINT.test(value.scopeFingerprint) ||
    value.playbookKey !== "surface-public-posture" ||
    value.playbookVersion !== "1.0.0" ||
    !validUtc(value.acceptedAt) ||
    !context ||
    !target ||
    !playbook
  )
    return "invalid";
  if (
    value.accountId !== context.accountId ||
    value.assessmentId !== context.assessmentId ||
    value.userId !== context.userId ||
    value.target !== target.url ||
    value.scopeFingerprint !== context.scopeFingerprint
  )
    return "mismatch";
  if (Date.parse(value.acceptedAt) > Date.parse(context.evaluatedAt)) return "invalid";
  return "ok";
}

type ParsedPlaybook = {
  actions: readonly AuthorizedAction[];
  actionIds: readonly string[];
  capabilities: readonly string[];
  limits: Readonly<{
    durationS: number;
    concurrency: number;
    ratePerMin: number;
    egress: readonly ["scope_target"];
  }>;
};

const PLAYBOOK_KEYS = [
  "schemaVersion",
  "key",
  "version",
  "targetCategory",
  "active",
  "preconditions",
  "actions",
  "limits",
  "stopSignals",
  "evidence",
  "severityPossible",
] as const;
const PLAYBOOK_ACTION_KEYS = ["id", "type", "allowedTargets", "method", "limit"] as const;
const PLAYBOOK_LIMIT_KEYS = [
  "maxDurationS",
  "maxConcurrency",
  "maxRatePerMin",
  "egress",
  "impactLevels",
] as const;
const STOP_SIGNALS = new Set([
  "scope_escape",
  "rate_exceeded",
  "unauthorized_endpoint",
  "duration_exceeded",
]);
const SEVERITY_LEVELS = new Set(["info", "low", "medium", "high", "critical"]);
const HTTP_ACTION_TYPES = new Set([
  "http_probe",
  "robots_fetch",
  "sitemap_fetch",
  "endpoint_probe",
]);

function exactKeys(snapshot: Snapshot, required: readonly string[]): boolean {
  return (
    snapshot.ok &&
    snapshot.keys.length === required.length &&
    required.every((key) => snapshot.keys.includes(key))
  );
}

function uniqueSafeStrings(
  input: unknown,
  allowed?: ReadonlySet<string>,
): readonly string[] | null {
  const values = snapshotArray(input);
  if (values === null || values.length === 0) return null;
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !SAFE_VERSION.test(value) || (allowed && !allowed.has(value)))
      return null;
    if (result.includes(value)) return null;
    result.push(value);
  }
  return result;
}

function parsePlaybook(
  input: unknown,
  category: string,
): { value?: ParsedPlaybook; code?: BlockCode } {
  if (input === null || input === undefined) return { code: "playbook_required" };
  const snapshot = snapshotObject(input, PLAYBOOK_KEYS);
  if (!snapshot.ok || !exactKeys(snapshot, PLAYBOOK_KEYS)) return { code: "invalid_playbook" };
  const value = snapshot.value;
  if (value.targetCategory !== category) return { code: "target_category_mismatch" };
  if (
    value.schemaVersion !== "playbook.schema@1" ||
    value.key !== "surface-public-posture" ||
    value.version !== "1.0.0" ||
    value.active !== true
  ) {
    return { code: "invalid_playbook" };
  }

  const preconditions = snapshotArray(value.preconditions);
  if (preconditions === null || preconditions.length === 0) return { code: "invalid_playbook" };
  const preconditionKeys = new Set<string>();
  let hasActiveHttpVerification = false;
  for (const precondition of preconditions) {
    const condition = snapshotObject(precondition, ["kind", "when"]);
    if (
      !condition.ok ||
      !exactKeys(condition, ["kind", "when"]) ||
      typeof condition.value.kind !== "string" ||
      !SAFE_VERSION.test(condition.value.kind) ||
      typeof condition.value.when !== "string" ||
      !SAFE_VERSION.test(condition.value.when)
    ) {
      return { code: "invalid_playbook" };
    }
    const key = `${condition.value.kind}\u0000${condition.value.when}`;
    if (preconditionKeys.has(key)) return { code: "invalid_playbook" };
    preconditionKeys.add(key);
    if (
      condition.value.kind === "http_verification_required" &&
      condition.value.when === "active_external"
    )
      hasActiveHttpVerification = true;
    if (
      condition.value.kind !== CANONICAL_PRECONDITIONS[0].kind ||
      condition.value.when !== CANONICAL_PRECONDITIONS[0].when
    )
      return { code: "invalid_playbook" };
  }
  if (!hasActiveHttpVerification || preconditionKeys.size !== 1)
    return { code: "invalid_playbook" };

  const actionValues = snapshotArray(value.actions);
  if (actionValues === null || actionValues.length === 0) return { code: "invalid_playbook" };
  const actions: AuthorizedAction[] = [];
  const actionIds: string[] = [];
  const capabilities: string[] = [];
  const actionDurations: number[] = [];
  const actionRequests: number[] = [];
  if (actionValues.length !== CANONICAL_ACTIONS.length) return { code: "invalid_playbook" };
  for (const [index, action] of actionValues.entries()) {
    const actionSnapshot = snapshotObject(action, PLAYBOOK_ACTION_KEYS);
    if (
      !actionSnapshot.ok ||
      (!exactKeys(actionSnapshot, ["id", "type", "allowedTargets", "limit"]) &&
        !exactKeys(actionSnapshot, PLAYBOOK_ACTION_KEYS))
    )
      return { code: "invalid_playbook" };
    if (!actionSnapshot.ok || typeof actionSnapshot.value.id !== "string")
      return { code: "invalid_playbook" };
    const id = actionSnapshot.value.id;
    if (!Object.prototype.hasOwnProperty.call(ACTION_MAP, id))
      return { code: "unknown_playbook_action" };
    const descriptor = ACTION_MAP[id as ActionId];
    const canonical = CANONICAL_ACTIONS[index];
    if (!canonical || id !== canonical.id) return { code: "invalid_playbook" };
    if (actionSnapshot.value.type !== descriptor.type) return { code: "unknown_playbook_action" };
    if (actionSnapshot.value.allowedTargets !== "scope")
      return { code: "target_category_not_allowed" };
    if (HTTP_ACTION_TYPES.has(descriptor.type)) {
      if (!isOwn(actionSnapshot.value, "method") || actionSnapshot.value.method !== "GET")
        return { code: "invalid_playbook" };
    } else if (isOwn(actionSnapshot.value, "method")) {
      return { code: "invalid_playbook" };
    }
    if (isOwn(actionSnapshot.value, "method")) {
      if (
        typeof actionSnapshot.value.method !== "string" ||
        !SAFE_VERSION.test(actionSnapshot.value.method)
      )
        return { code: "invalid_playbook" };
      if (HTTP_ACTION_TYPES.has(descriptor.type) && actionSnapshot.value.method !== "GET")
        return { code: "invalid_playbook" };
    }
    const actionLimit = snapshotObject(actionSnapshot.value.limit, ["requests", "durationS"]);
    if (
      !actionLimit.ok ||
      !exactKeys(actionLimit, ["requests", "durationS"]) ||
      typeof actionLimit.value.requests !== "number" ||
      actionLimit.value.requests <= 0 ||
      !Number.isSafeInteger(actionLimit.value.requests) ||
      typeof actionLimit.value.durationS !== "number" ||
      actionLimit.value.durationS <= 0 ||
      !Number.isSafeInteger(actionLimit.value.durationS)
    )
      return { code: "invalid_playbook" };
    if (
      actionLimit.value.requests !== canonical.limit.requests ||
      actionLimit.value.durationS !== canonical.limit.durationS
    )
      return { code: "invalid_playbook" };
    if (actionIds.includes(id)) return { code: "unknown_playbook_action" };
    actionIds.push(id);
    actionDurations.push(actionLimit.value.durationS);
    actionRequests.push(actionLimit.value.requests);
    if (!capabilities.includes(descriptor.capability)) capabilities.push(descriptor.capability);
    actions.push(Object.freeze({ ...canonical, capability: descriptor.capability }));
  }

  const playbookLimits = snapshotObject(value.limits, PLAYBOOK_LIMIT_KEYS);
  if (!playbookLimits.ok || !exactKeys(playbookLimits, PLAYBOOK_LIMIT_KEYS))
    return { code: "invalid_playbook" };
  const maxDurationS = playbookLimits.value.maxDurationS;
  const maxConcurrency = playbookLimits.value.maxConcurrency;
  const maxRatePerMin = playbookLimits.value.maxRatePerMin;
  if (
    typeof maxDurationS !== "number" ||
    maxDurationS <= 0 ||
    !Number.isSafeInteger(maxDurationS) ||
    typeof maxConcurrency !== "number" ||
    maxConcurrency <= 0 ||
    !Number.isSafeInteger(maxConcurrency) ||
    typeof maxRatePerMin !== "number" ||
    maxRatePerMin <= 0 ||
    !Number.isSafeInteger(maxRatePerMin)
  )
    return { code: "invalid_playbook" };
  if (maxDurationS !== 300 || maxConcurrency !== 1 || maxRatePerMin !== 10) {
    return { code: "invalid_playbook" };
  }
  if (actionDurations.some((durationS) => durationS > maxDurationS)) {
    return { code: "invalid_playbook" };
  }
  if (actionRequests.some((requests) => requests > maxRatePerMin)) {
    return { code: "invalid_playbook" };
  }
  const egress = snapshotObject(playbookLimits.value.egress, ["allow", "blockDefaults"]);
  const allow = egress.ok ? snapshotArray(egress.value.allow) : null;
  if (
    !egress.ok ||
    !exactKeys(egress, ["allow", "blockDefaults"]) ||
    egress.value.blockDefaults !== true ||
    allow === null ||
    allow.length !== 1 ||
    allow[0] !== "scope_target"
  )
    return { code: "invalid_playbook" };
  const impactLevels = uniqueSafeStrings(playbookLimits.value.impactLevels, SEVERITY_LEVELS);
  if (
    impactLevels === null ||
    impactLevels.length !== 1 ||
    impactLevels[0] !== CANONICAL_IMPACT_LEVELS[0]
  )
    return { code: "invalid_playbook" };

  const stopSignals = uniqueSafeStrings(value.stopSignals, STOP_SIGNALS);
  if (
    stopSignals === null ||
    stopSignals.length !== CANONICAL_STOP_SIGNALS.length ||
    stopSignals.some((signal, index) => signal !== CANONICAL_STOP_SIGNALS[index])
  )
    return { code: "invalid_playbook" };
  const evidence = snapshotObject(value.evidence, ["expected", "format"]);
  const expectedEvidence = evidence.ok ? uniqueSafeStrings(evidence.value.expected) : null;
  if (
    !evidence.ok ||
    !exactKeys(evidence, ["expected", "format"]) ||
    evidence.value.format !== "manifest" ||
    expectedEvidence === null ||
    expectedEvidence.length !== CANONICAL_EVIDENCE.expected.length ||
    expectedEvidence[0] !== CANONICAL_EVIDENCE.expected[0]
  )
    return { code: "invalid_playbook" };
  const severity = uniqueSafeStrings(value.severityPossible, SEVERITY_LEVELS);
  if (
    severity === null ||
    severity.length !== CANONICAL_SEVERITY.length ||
    severity.some((level, index) => level !== CANONICAL_SEVERITY[index])
  )
    return { code: "invalid_playbook" };
  return {
    value: {
      actions,
      actionIds,
      capabilities,
      limits: Object.freeze({
        durationS: maxDurationS,
        concurrency: maxConcurrency,
        ratePerMin: maxRatePerMin,
        egress: Object.freeze(["scope_target"] as const),
      }),
    },
  };
}

function limitsResult(
  input: unknown,
  playbookLimits?: ParsedPlaybook["limits"],
): { value?: EffectiveLimits; code?: BlockCode } {
  if (input === null || input === undefined) return { code: "invalid_limits" };
  try {
    const result = reduceLimits(input as LimitInput);
    if (!result || typeof result !== "object") return { code: "invalid_limits" };
    if (result.ok !== true)
      return { code: result.code === "invalid_egress" ? "invalid_egress" : "invalid_limits" };
    if (!result.value || typeof result.value !== "object") return { code: "invalid_limits" };
    if (!playbookLimits) return { value: result.value };
    return {
      value: Object.freeze({
        durationS: Math.min(result.value.durationS, playbookLimits.durationS),
        concurrency: Math.min(result.value.concurrency, playbookLimits.concurrency),
        ratePerMin: Math.min(result.value.ratePerMin, playbookLimits.ratePerMin),
        credits: result.value.credits,
        egress: Object.freeze(["scope_target"] as const),
      }),
    };
  } catch {
    return { code: "invalid_limits" };
  }
}

/** Pure final-authority policy reduction. It performs all checks and never executes caller actions. */
function authorizeUnsafe(input: ActionRequest): PolicyDecision {
  const blocked: BlockCode[] = [];
  const add = (code: BlockCode) => {
    if (!blocked.includes(code)) blocked.push(code);
  };
  let root: RecordValue = Object.create(null) as RecordValue;
  let rootValid = false;
  const snapshot = snapshotObject(input);
  if (snapshot.ok) {
    root = snapshot.value;
    rootValid = true;
  } else {
    add("target_invalid");
  }
  if (
    rootValid &&
    ["candidate", "candidateUrl", "url", "resolvedAddresses"].some((key) => isOwn(root, key))
  ) {
    add("target_invalid");
  }

  const action = rootValid && typeof root.action === "string" ? root.action : undefined;
  if (!action || !ACTIONS.has(action as RuntimeAction)) add("unknown_action");
  const category =
    rootValid && typeof root.targetCategory === "string" ? root.targetCategory : undefined;
  if (!category || !TARGET_CATEGORIES.has(category as TargetCategory))
    add("unknown_target_category");
  if (category && TARGET_CATEGORIES.has(category as TargetCategory) && category !== "surface") {
    add("target_category_not_allowed");
  }

  const contextResult = parseContext(rootValid ? root.context : undefined);
  if (contextResult.code) add(contextResult.code);
  const context = contextResult.value;
  const entitlement = parseEntitlement(rootValid ? root.entitlement : undefined, context);
  if (entitlement.code) add(entitlement.code);
  const plan = entitlement.plan;

  const target = rootValid
    ? parseTarget(root)
    : { candidate: undefined, addresses: undefined, malformed: true };
  const scoped = rootValid
    ? parseScope(root)
    : { scope: undefined, candidate: undefined, addresses: undefined, malformed: true };
  if (scoped.malformed) target.malformed = true;
  const normalized =
    target.candidate === undefined ? undefined : normalizeExternalUrl(target.candidate);
  if (target.malformed || !normalized || !normalized.ok) {
    if (normalized && !normalized.ok && normalized.code === "forbidden_target")
      add("forbidden_target");
    else add("target_invalid");
  }
  if (normalized?.ok && normalized.value.port !== 80 && normalized.value.port !== 443)
    add("port_not_allowed");

  const scope = scoped.scope;
  const scopeShape =
    scope && typeof scope === "object"
      ? snapshotObject(scope, ["inclusions", "exclusions"])
      : { ok: false as const };
  if (
    !scope ||
    typeof scope !== "object" ||
    !scopeShape.ok ||
    !isOwn(scopeShape.value, "inclusions") ||
    !isOwn(scopeShape.value, "exclusions") ||
    !isCompiledScope(scope)
  ) {
    add("scope_required");
    add("target_invalid");
  } else if (normalized?.ok && !matchesScope(scope, target.candidate ?? "")) {
    add("target_out_of_scope");
  } else if (context && fingerprintScope(scope) !== context.scopeFingerprint) {
    add("invalid_context");
  }
  let resolvedAddresses: readonly string[] | undefined;
  if (normalized?.ok) {
    const addresses = validateResolvedAddresses(normalized.value.hostname, target.addresses ?? []);
    if (!addresses.ok) {
      if (addresses.code === "resolved_addresses_required") add("resolved_addresses_required");
      else if (addresses.code === "forbidden_resolved_address") add("forbidden_target");
      else add("target_invalid");
    } else resolvedAddresses = addresses.value;
  }

  const parsedPlaybook = parsePlaybook(rootValid ? root.playbook : undefined, category ?? "");
  if (parsedPlaybook.code) add(parsedPlaybook.code);

  const normalizedTarget = normalized?.ok ? normalized.value : undefined;
  const attestation = parseAttestation(
    rootValid ? root.attestation : undefined,
    context,
    normalizedTarget,
    parsedPlaybook.value,
  );
  if (attestation === "required") add("attestation_required");
  else if (attestation === "mismatch") add("attestation_context_mismatch");
  else if (attestation === "invalid") add("invalid_attestation");

  const verification = parseVerification(
    rootValid ? root.verification : undefined,
    context,
    normalizedTarget,
  );
  if (verification === "method_not_allowed") add("verification_method_not_allowed");
  else if (verification === "mismatch") add("verification_context_mismatch");
  else if (verification === "expired") add("verification_expired");
  else if (verification === "invalid") {
    if (action === "active_external") add("verification_required");
    else add("verification_required");
  } else if (action === "active_external" && verification === "unverified")
    add("verification_not_verified");
  if (action === "active_external" && verification === "none") add("verification_required");
  if (rootValid && ["actions", "capabilities", "commands"].some((field) => isOwn(root, field))) {
    add("caller_execution_fields_not_allowed");
  }

  const reduced = limitsResult(rootValid ? root.limits : undefined, parsedPlaybook.value?.limits);
  if (reduced.code) add(reduced.code);

  if (action === "active_external" && plan === "free_unverified") add("plan_action_not_allowed");
  if (blocked.length > 0 || !parsedPlaybook.value || !reduced.value) return denied(blocked);
  if (plan === undefined) return denied(["unknown_plan"]);
  if (action !== "passive_external" && action !== "active_external")
    return denied(["unknown_action"]);
  if (!normalizedTarget || !resolvedAddresses || !context) return denied(["target_invalid"]);
  // rightsForPlan is deliberately consulted only after validation; it is the server-owned matrix.
  try {
    const rights = rightsForPlan(plan);
    const effectiveLimits =
      reduced.value.credits <= rights.maxCredits
        ? reduced.value
        : Object.freeze({
            ...reduced.value,
            credits: rights.maxCredits,
            egress: Object.freeze(["scope_target"] as const),
          });
    const effectiveActions = parsedPlaybook.value.actions.map((action) =>
      Object.freeze({
        ...action,
        limit: Object.freeze({
          requests: Math.min(action.limit.requests, effectiveLimits.ratePerMin),
          durationS: Math.min(action.limit.durationS, effectiveLimits.durationS),
        }),
      }),
    );
    return allowed(
      effectiveActions,
      parsedPlaybook.value.capabilities,
      effectiveLimits,
      normalizedTarget,
      resolvedAddresses,
      context.scopeFingerprint,
    );
  } catch {
    return denied(["unknown_plan"]);
  }
}

/** Defensive public boundary: malformed runtime objects can never escape as exceptions. */
export function authorize(input: ActionRequest): PolicyDecision {
  try {
    return authorizeUnsafe(input);
  } catch {
    return denied(["target_invalid"]);
  }
}
