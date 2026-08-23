import {
  membershipRoleSchema,
  membershipStatusSchema,
  type MembershipRole,
  type MembershipStatus,
} from "@touchmyapi/contracts";

export type MembershipCapability =
  | "account:read"
  | "membership:manage"
  | "assessment:read"
  | "assessment:create"
  | "assessment:cancel"
  | "billing:read"
  | "billing:purchase";

export type MembershipEvaluation = Readonly<{
  allowed: boolean;
  accountId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  capabilities: readonly MembershipCapability[];
  reason: "ok" | "membership_suspended" | "membership_required";
}>;

export type MembershipInput = Readonly<{
  accountId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
}>;

export type LastOwnerDecision = Readonly<{
  allowed: boolean;
  reason: "ok" | "last_owner_protected";
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITIES = new Set<MembershipCapability>([
  "account:read",
  "membership:manage",
  "assessment:read",
  "assessment:create",
  "assessment:cancel",
  "billing:read",
  "billing:purchase",
]);

const ROLE_CAPABILITIES: Readonly<Record<MembershipRole, readonly MembershipCapability[]>> =
  Object.freeze({
    owner: Object.freeze([
      "account:read",
      "membership:manage",
      "assessment:read",
      "assessment:create",
      "assessment:cancel",
      "billing:read",
    ]) as readonly MembershipCapability[],
    admin: Object.freeze([
      "account:read",
      "membership:manage",
      "assessment:read",
      "assessment:create",
      "assessment:cancel",
      "billing:read",
    ]) as readonly MembershipCapability[],
    operator: Object.freeze([
      "account:read",
      "assessment:read",
      "assessment:create",
      "assessment:cancel",
    ]) as readonly MembershipCapability[],
    viewer: Object.freeze(["account:read", "assessment:read"]) as readonly MembershipCapability[],
    billing: Object.freeze([
      "account:read",
      "billing:read",
      "billing:purchase",
    ]) as readonly MembershipCapability[],
  });

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`invalid ${field}`);
}

function assertRoleStatus(role: unknown, status: unknown): asserts role is MembershipRole {
  if (!membershipRoleSchema.safeParse(role).success) throw new TypeError("invalid membership role");
  if (!membershipStatusSchema.safeParse(status).success)
    throw new TypeError("invalid membership status");
}

/** Resolve an immutable, default-deny capability snapshot for one account/user membership. */
export function evaluateMembership(input: MembershipInput): MembershipEvaluation {
  assertIdentity(input.accountId, "account id");
  assertIdentity(input.userId, "user id");
  assertRoleStatus(input.role, input.status);
  const active = input.status === "active";
  const capabilities = active ? ROLE_CAPABILITIES[input.role] : [];
  return Object.freeze({
    allowed: active,
    accountId: input.accountId,
    userId: input.userId,
    role: input.role,
    status: input.status,
    capabilities,
    reason: active ? "ok" : "membership_suspended",
  });
}

/** Check a capability against a snapshot; unknown capabilities fail closed. */
export function canMembershipCapability(
  evaluation: MembershipEvaluation,
  capability: MembershipCapability,
): boolean {
  return (
    evaluation.allowed &&
    CAPABILITIES.has(capability) &&
    evaluation.capabilities.includes(capability)
  );
}

/** Transaction-layer guard; callers must pass a lock-protected active-owner count. */
export function lastOwnerDecision(input: {
  currentRole: MembershipRole;
  activeOwnerCount: number;
}): LastOwnerDecision {
  if (!membershipRoleSchema.safeParse(input.currentRole).success)
    throw new TypeError("invalid membership role");
  if (!Number.isSafeInteger(input.activeOwnerCount) || input.activeOwnerCount < 0) {
    throw new TypeError("invalid active owner count");
  }
  if (input.currentRole === "owner" && input.activeOwnerCount <= 1) {
    return Object.freeze({ allowed: false, reason: "last_owner_protected" });
  }
  return Object.freeze({ allowed: true, reason: "ok" });
}
