import {
  matchesScope,
  normalizeExternalUrl,
  validateResolvedAddresses,
  type CompiledScope,
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
  | "scope_required"
  | "target_invalid"
  | "target_out_of_scope"
  | "resolved_addresses_required"
  | "forbidden_target"
  | "port_not_allowed"
  | "attestation_required"
  | "invalid_attestation"
  | "verification_required"
  | "verification_method_not_allowed"
  | "verification_not_verified"
  | "playbook_required"
  | "invalid_playbook"
  | "unknown_playbook_action"
  | "capability_not_allowed"
  | "plan_action_not_allowed"
  | "invalid_limits"
  | "invalid_egress"
  | "caller_execution_fields_not_allowed";

export type PolicyBlock = Readonly<{ code: BlockCode }>;

export type ActionRequest = Readonly<{
  action: string;
  targetCategory: string;
  /** A URL string, or a target descriptor containing a candidate URL and DNS facts. */
  target: unknown;
  scope: CompiledScope;
  entitlement: Plan | string;
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
  actions: readonly string[];
  capabilities: readonly string[];
  limits: EffectiveLimits | null;
}>;

type RecordValue = Record<string, unknown>;
type Snapshot = { ok: true; value: RecordValue; keys: readonly string[] } | { ok: false };

const TARGET_CATEGORIES = new Set<TargetCategory>(["web", "api", "surface", "genai", "internal"]);
const ACTIONS = new Set<RuntimeAction>(["passive_external", "active_external"]);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

const ACTION_MAP = Object.freeze({
  "dns.records": Object.freeze({ type: "dns_lookup", capability: "dns_resolver" }),
  "tls.cert": Object.freeze({ type: "tls_probe", capability: "tls_probe" }),
  "http.headers": Object.freeze({ type: "http_probe", capability: "http_client" }),
  "robots.txt": Object.freeze({ type: "robots_fetch", capability: "http_client" }),
  "sitemap.xml": Object.freeze({ type: "sitemap_fetch", capability: "http_client" }),
  "endpoint.minimal": Object.freeze({ type: "endpoint_probe", capability: "http_client" }),
} as const);
type ActionId = keyof typeof ACTION_MAP;

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
  });
}

function allowed(
  actions: readonly string[],
  capabilities: readonly string[],
  limits: EffectiveLimits,
): PolicyDecision {
  return freezeDeep({
    allowed: true,
    blocked: [],
    reason: "allowed",
    actions: [...actions],
    capabilities: [...capabilities],
    limits,
  });
}

function parseTarget(root: RecordValue): {
  candidate: string | undefined;
  addresses: readonly string[] | undefined;
  malformed: boolean;
} {
  let candidate: unknown;
  let addresses: unknown;
  let malformed = false;
  if (isOwn(root, "target")) {
    const target = root.target;
    if (typeof target === "string") {
      candidate = target;
    } else {
      const targetSnapshot = snapshotObject(target, [
        "candidate",
        "candidateUrl",
        "url",
        "resolvedAddresses",
      ]);
      if (!targetSnapshot.ok) malformed = true;
      else {
        candidate = isOwn(targetSnapshot.value, "candidate")
          ? targetSnapshot.value.candidate
          : isOwn(targetSnapshot.value, "candidateUrl")
            ? targetSnapshot.value.candidateUrl
            : targetSnapshot.value.url;
        addresses = targetSnapshot.value.resolvedAddresses;
      }
    }
  }
  if (isOwn(root, "candidate")) candidate = root.candidate;
  if (isOwn(root, "candidateUrl")) candidate = root.candidateUrl;
  if (isOwn(root, "resolvedAddresses")) addresses = root.resolvedAddresses;
  if (candidate !== undefined && typeof candidate !== "string") malformed = true;
  if (addresses !== undefined) {
    const addressSnapshot = snapshotArray(addresses);
    if (
      addressSnapshot === null ||
      addressSnapshot.some((address) => typeof address !== "string")
    ) {
      malformed = true;
      addresses = undefined;
    } else {
      addresses = addressSnapshot as readonly string[];
    }
  }
  return {
    candidate: typeof candidate === "string" ? candidate : undefined,
    addresses: Array.isArray(addresses) ? (addresses as readonly string[]) : undefined,
    malformed,
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
  const wrapper = snapshotObject(raw, [
    "compiled",
    "compiledScope",
    "candidate",
    "candidateUrl",
    "resolvedAddresses",
  ]);
  if (wrapper.ok && (isOwn(wrapper.value, "compiled") || isOwn(wrapper.value, "compiledScope"))) {
    const compiled = isOwn(wrapper.value, "compiled")
      ? wrapper.value.compiled
      : wrapper.value.compiledScope;
    const candidate = isOwn(wrapper.value, "candidate")
      ? wrapper.value.candidate
      : wrapper.value.candidateUrl;
    const addresses = wrapper.value.resolvedAddresses;
    let normalizedAddresses: readonly string[] | undefined;
    let malformed =
      (candidate !== undefined && typeof candidate !== "string") ||
      (addresses !== undefined && !Array.isArray(addresses));
    if (!malformed && addresses !== undefined) {
      const addressSnapshot = snapshotArray(addresses);
      if (
        addressSnapshot === null ||
        addressSnapshot.some((address) => typeof address !== "string")
      ) {
        malformed = true;
      } else {
        normalizedAddresses = addressSnapshot as readonly string[];
      }
    }
    return {
      scope: compiled,
      candidate: typeof candidate === "string" ? candidate : undefined,
      addresses: normalizedAddresses,
      malformed,
    };
  }
  return { scope: raw, candidate: undefined, addresses: undefined, malformed: false };
}

function validAttestation(input: unknown): "required" | "invalid" | "ok" {
  if (input === null || input === undefined) return "required";
  const snapshot = snapshotObject(input, ["version"]);
  if (!snapshot.ok || !isOwn(snapshot.value, "version")) return "invalid";
  return typeof snapshot.value.version === "string" && SAFE_VERSION.test(snapshot.value.version)
    ? "ok"
    : "invalid";
}

type VerificationState =
  "none" | "invalid" | "http_verified" | "http_unverified" | "other_verified" | "other_unverified";
function parseVerification(input: unknown): VerificationState {
  if (input === null || input === undefined) return "none";
  const snapshot = snapshotObject(input, ["method", "status"]);
  if (
    !snapshot.ok ||
    typeof snapshot.value.method !== "string" ||
    typeof snapshot.value.status !== "string"
  ) {
    return "invalid";
  }
  if (snapshot.value.method === "http_file") {
    return snapshot.value.status === "verified" ? "http_verified" : "http_unverified";
  }
  return snapshot.value.status === "verified" ? "other_verified" : "other_unverified";
}

type ParsedPlaybook = {
  actions: readonly string[];
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
  }
  if (!hasActiveHttpVerification) return { code: "invalid_playbook" };

  const actionValues = snapshotArray(value.actions);
  if (actionValues === null || actionValues.length === 0) return { code: "invalid_playbook" };
  const actions: string[] = [];
  const capabilities: string[] = [];
  const actionDurations: number[] = [];
  for (const action of actionValues) {
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
    if (actionSnapshot.value.type !== descriptor.type) return { code: "unknown_playbook_action" };
    if (actionSnapshot.value.allowedTargets !== "scope")
      return { code: "target_category_not_allowed" };
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
    if (actions.includes(id)) return { code: "unknown_playbook_action" };
    actions.push(id);
    actionDurations.push(actionLimit.value.durationS);
    if (!capabilities.includes(descriptor.capability)) capabilities.push(descriptor.capability);
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
  if (actionDurations.some((durationS) => durationS > maxDurationS)) {
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
  if (uniqueSafeStrings(playbookLimits.value.impactLevels, SEVERITY_LEVELS) === null)
    return { code: "invalid_playbook" };

  if (uniqueSafeStrings(value.stopSignals, STOP_SIGNALS) === null)
    return { code: "invalid_playbook" };
  const evidence = snapshotObject(value.evidence, ["expected", "format"]);
  if (
    !evidence.ok ||
    !exactKeys(evidence, ["expected", "format"]) ||
    evidence.value.format !== "manifest" ||
    uniqueSafeStrings(evidence.value.expected) === null
  )
    return { code: "invalid_playbook" };
  if (uniqueSafeStrings(value.severityPossible, SEVERITY_LEVELS) === null)
    return { code: "invalid_playbook" };
  return {
    value: {
      actions,
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

  const action = rootValid && typeof root.action === "string" ? root.action : undefined;
  if (!action || !ACTIONS.has(action as RuntimeAction)) add("unknown_action");
  const category =
    rootValid && typeof root.targetCategory === "string" ? root.targetCategory : undefined;
  if (!category || !TARGET_CATEGORIES.has(category as TargetCategory))
    add("unknown_target_category");
  if (category && TARGET_CATEGORIES.has(category as TargetCategory) && category !== "surface") {
    add("target_category_not_allowed");
  }

  const plan =
    rootValid && typeof root.entitlement === "string" && isPlan(root.entitlement)
      ? root.entitlement
      : undefined;
  if (!plan) add("unknown_plan");

  const target = rootValid
    ? parseTarget(root)
    : { candidate: undefined, addresses: undefined, malformed: true };
  const scoped = rootValid
    ? parseScope(root)
    : { scope: undefined, candidate: undefined, addresses: undefined, malformed: true };
  if (target.candidate === undefined && scoped.candidate !== undefined)
    target.candidate = scoped.candidate;
  if (target.addresses === undefined && scoped.addresses !== undefined)
    target.addresses = scoped.addresses;
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
    !isOwn(scopeShape.value, "exclusions")
  ) {
    add("scope_required");
  } else if (normalized?.ok && !matchesScope(scope as CompiledScope, target.candidate ?? "")) {
    add("target_out_of_scope");
  }
  if (normalized?.ok) {
    const addresses = validateResolvedAddresses(normalized.value.hostname, target.addresses ?? []);
    if (!addresses.ok) {
      if (addresses.code === "resolved_addresses_required") add("resolved_addresses_required");
      else if (addresses.code === "forbidden_resolved_address") add("forbidden_target");
      else add("target_invalid");
    }
  }

  const attestation = validAttestation(rootValid ? root.attestation : undefined);
  if (attestation === "required") add("attestation_required");
  else if (attestation === "invalid") add("invalid_attestation");

  const verification = parseVerification(rootValid ? root.verification : undefined);
  if (verification === "other_verified" || verification === "other_unverified") {
    add("verification_method_not_allowed");
  }
  if (action === "active_external") {
    if (verification === "none" || verification === "invalid") add("verification_required");
    else if (verification === "http_unverified") add("verification_not_verified");
    else if (verification === "other_unverified") {
      add("verification_not_verified");
    }
  }

  const parsedPlaybook = parsePlaybook(rootValid ? root.playbook : undefined, category ?? "");
  if (parsedPlaybook.code) add(parsedPlaybook.code);
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
    return allowed(
      parsedPlaybook.value.actions,
      parsedPlaybook.value.capabilities,
      effectiveLimits,
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
