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

type CeilingKey = (typeof CEILING_KEYS)[number];
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function frozenFailure(code: LimitErrorCode): LimitResult {
  return Object.freeze({ ok: false as const, code });
}

function validateCeiling(value: unknown): LimitCeiling | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CEILING_KEYS)) return null;
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

function validatePlaybook(value: unknown): { limits: LimitCeiling; egress: true } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [...CEILING_KEYS, "egress"])) return null;
  const limits = {} as Record<CeilingKey, number>;
  for (const key of CEILING_KEYS) {
    if (!hasOwn(value, key) || !isPositiveSafeInteger(value[key])) return null;
    limits[key] = value[key] as number;
  }
  if (!hasOwn(value, "egress")) return null;
  const egress = value.egress;
  if (!Array.isArray(egress) || egress.length !== 1 || egress[0] !== "scope_target") return null;
  return { limits, egress: true };
}

function validateRequested(value: unknown): Partial<LimitCeiling> | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CEILING_KEYS)) return null;
  for (const key of Object.keys(value) as CeilingKey[]) {
    if (!isPositiveSafeInteger(value[key])) return null;
  }
  return value as Partial<LimitCeiling>;
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
  if (!isRecord(input) || !hasOnlyKeys(input, ROOT_KEYS)) {
    return frozenFailure("invalid_authoritative_limit");
  }

  for (const source of ["playbook", "entitlement", "account", "global"] as const) {
    if (!hasOwn(input, source)) return frozenFailure("missing_authoritative_limit");
  }

  const playbook = validatePlaybook(input.playbook);
  if (playbook === null) {
    if (isRecord(input.playbook) && !hasOwn(input.playbook, "egress")) {
      return frozenFailure("invalid_egress");
    }
    if (isRecord(input.playbook) && hasOwn(input.playbook, "egress")) {
      const egress = input.playbook.egress;
      if (!Array.isArray(egress) || egress.length !== 1 || egress[0] !== "scope_target") {
        return frozenFailure("invalid_egress");
      }
    }
    return frozenFailure("invalid_authoritative_limit");
  }

  const entitlement = validateCeiling(input.entitlement);
  const account = validateCeiling(input.account);
  const global = validateCeiling(input.global);
  if (entitlement === null || account === null || global === null) {
    return frozenFailure("invalid_authoritative_limit");
  }

  let requested: Partial<LimitCeiling> | undefined;
  if (hasOwn(input, "requested")) {
    const parsedRequested = validateRequested(input.requested);
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
}
