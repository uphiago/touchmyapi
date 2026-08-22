/** Pure, non-escalating limit reduction. No caller-provided value can widen authority. */

export type LimitCeiling = Readonly<{
  durationS: number;
  concurrency: number;
  ratePerMin: number;
  credits: number;
}>;

export type PlaybookLimits = LimitCeiling &
  Readonly<{
    egress: readonly ["scope_target"];
  }>;

export type LimitInput = Readonly<{
  playbook: PlaybookLimits;
  entitlement: LimitCeiling;
  account: LimitCeiling;
  requested?: Partial<LimitCeiling>;
  global: LimitCeiling;
}>;

export type EffectiveLimits = LimitCeiling &
  Readonly<{
    egress: readonly ["scope_target"];
  }>;

export type LimitResult =
  | Readonly<{ ok: true; value: EffectiveLimits }>
  | Readonly<{
      ok: false;
      code:
        | "missing_authoritative_limit"
        | "invalid_authoritative_limit"
        | "invalid_requested_limit"
        | "invalid_egress";
    }>;

type LimitErrorCode =
  | "missing_authoritative_limit"
  | "invalid_authoritative_limit"
  | "invalid_requested_limit"
  | "invalid_egress";

const CEILING_KEYS = ["durationS", "concurrency", "ratePerMin", "credits"] as const;
const ROOT_KEYS = ["playbook", "entitlement", "account", "requested", "global"] as const;
const PLAYBOOK_KEYS = [...CEILING_KEYS, "egress"] as const;

type CeilingKey = (typeof CEILING_KEYS)[number];
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function frozenFailure(code: LimitErrorCode): LimitResult {
  return Object.freeze({ ok: false as const, code });
}

type SnapshotResult = { ok: true; value: RecordValue } | { ok: false; code: LimitErrorCode };

function snapshotFailure(code: LimitErrorCode): SnapshotResult {
  return { ok: false, code };
}

function snapshotRecord(
  value: unknown,
  allowedKeys: readonly string[],
  invalidCode: LimitErrorCode,
  accessorCode?: (key: string) => LimitErrorCode,
): SnapshotResult {
  try {
    if (!isRecord(value)) return snapshotFailure(invalidCode);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return snapshotFailure(invalidCode);
    }

    const snapshot = Object.create(null) as RecordValue;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedKeys.includes(key)) {
        return snapshotFailure(invalidCode);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return snapshotFailure(invalidCode);
      if (!("value" in descriptor)) {
        return snapshotFailure(accessorCode?.(key) ?? invalidCode);
      }
      snapshot[key] = descriptor.value;
    }
    return { ok: true, value: snapshot };
  } catch {
    return snapshotFailure(invalidCode);
  }
}

function validateCeiling(value: RecordValue): LimitCeiling | null {
  for (const key of CEILING_KEYS) {
    if (!hasOwn(value, key) || !isPositiveSafeInteger(value[key])) return null;
  }
  return {
    durationS: value.durationS as number,
    concurrency: value.concurrency as number,
    ratePerMin: value.ratePerMin as number,
    credits: value.credits as number,
  };
}

function validateEgress(value: unknown): boolean {
  try {
    if (!Array.isArray(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("0") || !keys.includes("length")) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const itemDescriptor = Object.getOwnPropertyDescriptor(value, "0");
    return (
      lengthDescriptor !== undefined &&
      "value" in lengthDescriptor &&
      lengthDescriptor.value === 1 &&
      itemDescriptor !== undefined &&
      "value" in itemDescriptor &&
      itemDescriptor.value === "scope_target"
    );
  } catch {
    return false;
  }
}

type PlaybookValidation =
  | { ok: true; limits: LimitCeiling }
  | { ok: false; code: "invalid_authoritative_limit" | "invalid_egress" };

function validatePlaybook(value: RecordValue): PlaybookValidation {
  const limits = validateCeiling(value);
  if (limits === null) return { ok: false, code: "invalid_authoritative_limit" };
  if (!hasOwn(value, "egress") || !validateEgress(value.egress)) {
    return { ok: false, code: "invalid_egress" };
  }
  return { ok: true, limits };
}

function validateRequested(value: unknown): Partial<LimitCeiling> | null {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const snapshot = snapshotRecord(value, CEILING_KEYS, "invalid_requested_limit");
    if (!snapshot.ok) return null;
    for (const key of CEILING_KEYS) {
      if (hasOwn(snapshot.value, key) && !isPositiveSafeInteger(snapshot.value[key])) return null;
    }
    return snapshot.value as Partial<LimitCeiling>;
  } catch {
    return null;
  }
}

function minFor(
  key: CeilingKey,
  authorities: readonly LimitCeiling[],
  requested: Partial<LimitCeiling> | undefined,
): number {
  const values = authorities.map((authority) => authority[key]);
  const requestedValue = requested?.[key];
  if (requestedValue !== undefined) values.push(requestedValue);
  return Math.min(...values);
}

export function reduceLimits(input: LimitInput): LimitResult {
  try {
    const rootSnapshot = snapshotRecord(input, ROOT_KEYS, "invalid_authoritative_limit");
    if (!rootSnapshot.ok) return frozenFailure(rootSnapshot.code);
    const root = rootSnapshot.value;

    for (const source of ["playbook", "entitlement", "account", "global"] as const) {
      if (!hasOwn(root, source)) return frozenFailure("missing_authoritative_limit");
    }

    const playbookSnapshot = snapshotRecord(
      root.playbook,
      PLAYBOOK_KEYS,
      "invalid_authoritative_limit",
      (key) => (key === "egress" ? "invalid_egress" : "invalid_authoritative_limit"),
    );
    if (!playbookSnapshot.ok) return frozenFailure(playbookSnapshot.code);
    const playbook = validatePlaybook(playbookSnapshot.value);
    if (!playbook.ok) return frozenFailure(playbook.code);

    const entitlementSnapshot = snapshotRecord(
      root.entitlement,
      CEILING_KEYS,
      "invalid_authoritative_limit",
    );
    const accountSnapshot = snapshotRecord(
      root.account,
      CEILING_KEYS,
      "invalid_authoritative_limit",
    );
    const globalSnapshot = snapshotRecord(root.global, CEILING_KEYS, "invalid_authoritative_limit");
    if (!entitlementSnapshot.ok || !accountSnapshot.ok || !globalSnapshot.ok) {
      return frozenFailure("invalid_authoritative_limit");
    }

    const entitlement = validateCeiling(entitlementSnapshot.value);
    const account = validateCeiling(accountSnapshot.value);
    const global = validateCeiling(globalSnapshot.value);
    if (entitlement === null || account === null || global === null) {
      return frozenFailure("invalid_authoritative_limit");
    }

    let requested: Partial<LimitCeiling> | undefined;
    if (hasOwn(root, "requested")) {
      const parsedRequested = validateRequested(root.requested);
      if (parsedRequested === null) return frozenFailure("invalid_requested_limit");
      requested = parsedRequested;
    }

    const authorities = [playbook.limits, entitlement, account, global] as const;
    const value: EffectiveLimits = Object.freeze({
      durationS: minFor("durationS", authorities, requested),
      concurrency: minFor("concurrency", authorities, requested),
      ratePerMin: minFor("ratePerMin", authorities, requested),
      credits: minFor("credits", authorities, requested),
      egress: Object.freeze(["scope_target"] as const),
    });
    return Object.freeze({ ok: true as const, value });
  } catch {
    return frozenFailure("invalid_authoritative_limit");
  }
}
