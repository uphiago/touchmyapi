import {
  invitationCreateResponseSchema,
  invitationCreateSchema,
  membershipListResponseSchema,
  membershipMutationResponseSchema,
  membershipRoleSchema,
  membershipUpdateSchema,
  type Invitation,
  type InvitationCreate,
  type Membership,
  type MembershipRole,
  type MembershipStatus,
} from "@touchmyapi/contracts";
import type { Context, Hono } from "hono";
import { ApiError } from "./error";
import { generateSessionToken, hashSessionToken, readSessionToken, type AuthStore } from "./auth";
import type { ApiEnvironment } from "./config";
import type { ApiRequestEnv } from "./request-id";

type MembershipFailureCode =
  | "membership_required"
  | "membership_suspended"
  | "active_account_required"
  | "last_owner_protected"
  | "invalid_invitation";

export type MembershipOperationResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: MembershipFailureCode }>;

export type MembershipStore = Readonly<{
  listMemberships: (input: {
    sessionHash: string;
    accountId: string;
  }) => Promise<MembershipOperationResult<readonly Membership[]>>;
  createInvitation: (input: {
    sessionHash: string;
    accountId: string;
    email: InvitationCreate["email"];
    role: MembershipRole;
    expiresAt: Date;
    tokenHash: string;
    /** Handed only to the store's durable delivery boundary; never SQL/log persistence. */
    deliveryToken: string;
    /** Must be appended in the same transaction as the invitation mutation. */
    audit: MembershipAuditEvent;
  }) => Promise<MembershipOperationResult<Invitation>>;
  updateMembership: (input: {
    sessionHash: string;
    accountId: string;
    userId: string;
    role?: MembershipRole;
    status?: MembershipStatus;
    /** Must be appended in the same transaction as the membership mutation. */
    audit: MembershipAuditEvent;
  }) => Promise<MembershipOperationResult<Membership>>;
  /** The store must revoke target sessions in the same transaction as removal. */
  removeMembership: (input: {
    sessionHash: string;
    accountId: string;
    userId: string;
    /** Must revoke sessions and append this audit event in one transaction. */
    audit: MembershipAuditEvent;
  }) => Promise<MembershipOperationResult<Membership>>;
}>;

export type MembershipAuditEvent = Readonly<{
  accountId: string;
  actorUserId: string;
  action: "membership.invitation_created" | "membership.updated" | "membership.removed";
  targetUserId?: string;
}>;

export type MembershipDependencies = Readonly<{
  store: MembershipStore;
  resolveSession: AuthStore["resolveSession"];
  allowInsecureCookies?: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function operationError(code: MembershipFailureCode): ApiError {
  if (code === "last_owner_protected") {
    return new ApiError(409, code, "The last active owner cannot be removed or demoted");
  }
  if (code === "membership_suspended") {
    return new ApiError(403, code, "Membership is suspended");
  }
  if (code === "active_account_required") {
    return new ApiError(403, code, "Active account required");
  }
  if (code === "invalid_invitation") {
    return new ApiError(400, code, "Invalid invitation");
  }
  return new ApiError(403, code, "Membership required");
}

function assertUuid(value: string | undefined, code: MembershipFailureCode): string {
  if (!value || !UUID.test(value)) throw operationError(code);
  return value.toLowerCase();
}

function isInputError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "ZodError")
  );
}

function parseInvitationExpiry(value: string): Date {
  const date = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now) {
    throw new ApiError(400, "invalid_invitation", "Invitation expiry is invalid");
  }
  if (date.getTime() > now + MAX_INVITATION_LIFETIME_MS) {
    throw new ApiError(400, "invalid_invitation", "Invitation expiry is invalid");
  }
  return date;
}

function assertSuccess<T>(result: MembershipOperationResult<T>): T {
  if (!result.ok) throw operationError(result.code);
  return result.value;
}

async function sessionForAccount(
  context: Context<ApiRequestEnv>,
  dependencies: MembershipDependencies,
  sessionCookieName: string,
  accountId: string,
): Promise<{ sessionHash: string; role: string; userId: string }> {
  const token = readSessionToken(context.req.raw, sessionCookieName);
  if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
  const sessionHash = await hashSessionToken(token);
  const session = await dependencies.resolveSession(sessionHash);
  if (!session) throw new ApiError(401, "unauthorized", "Authentication required");
  if (session.accountId !== accountId) throw operationError("active_account_required");
  if (session.membershipStatus !== "active") {
    throw operationError(
      session.membershipStatus === "suspended" ? "membership_suspended" : "membership_required",
    );
  }
  return { sessionHash, role: session.role, userId: session.userId };
}

function requireMembershipManager(role: string): void {
  if (!membershipRoleSchema.safeParse(role).success || (role !== "owner" && role !== "admin")) {
    throw operationError("membership_required");
  }
}

export function registerMembershipRoutes(
  api: Hono<ApiRequestEnv>,
  dependencies: MembershipDependencies,
  environment: ApiEnvironment = "production",
): void {
  const sessionCookieName =
    dependencies.allowInsecureCookies === true && environment === "development"
      ? "tma-session"
      : "__Secure-tma-session";

  const withAccount = async (
    context: Context<ApiRequestEnv>,
    callback: (
      sessionHash: string,
      accountId: string,
      role: string,
      userId: string,
    ) => Promise<Response>,
  ): Promise<Response> => {
    const accountId = assertUuid(context.req.param("accountId"), "active_account_required");
    const { sessionHash, role, userId } = await sessionForAccount(
      context,
      dependencies,
      sessionCookieName,
      accountId,
    );
    return callback(sessionHash, accountId, role, userId);
  };

  api.get("/api/v1/accounts/:accountId/memberships", async (context) => {
    try {
      return await withAccount(context, async (sessionHash, accountId) => {
        const memberships = assertSuccess(
          await dependencies.store.listMemberships({ sessionHash, accountId }),
        );
        return context.json(membershipListResponseSchema.parse({ memberships }));
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "membership_unavailable", "Membership service unavailable");
    }
  });

  api.post("/api/v1/accounts/:accountId/memberships/invitations", async (context) => {
    try {
      return await withAccount(context, async (sessionHash, accountId, role, userId) => {
        requireMembershipManager(role);
        const body = invitationCreateSchema.parse(await context.req.json());
        const expiresAt = parseInvitationExpiry(body.expiresAt);
        const token = generateSessionToken();
        const invitation = assertSuccess(
          await dependencies.store.createInvitation({
            sessionHash,
            accountId,
            email: body.email,
            role: body.role,
            expiresAt,
            tokenHash: await hashSessionToken(token),
            deliveryToken: token,
            audit: {
              accountId,
              actorUserId: userId,
              action: "membership.invitation_created",
            },
          }),
        );
        return context.json(invitationCreateResponseSchema.parse({ invitation }), 201);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isInputError(error)) {
        throw new ApiError(400, "invalid_invitation", "Invalid invitation");
      }
      throw new ApiError(503, "membership_unavailable", "Membership service unavailable");
    }
  });

  const updateMembership = async (context: Context<ApiRequestEnv>) => {
    try {
      return await withAccount(context, async (sessionHash, accountId, role, actorUserId) => {
        requireMembershipManager(role);
        const userId = assertUuid(context.req.param("userId"), "membership_required");
        const body = membershipUpdateSchema.parse(await context.req.json());
        const membership = assertSuccess(
          await dependencies.store.updateMembership({
            sessionHash,
            accountId,
            userId,
            ...(body.role === undefined ? {} : { role: body.role }),
            ...(body.status === undefined ? {} : { status: body.status }),
            audit: {
              accountId,
              actorUserId,
              action: "membership.updated",
              targetUserId: userId,
            },
          }),
        );
        return context.json(membershipMutationResponseSchema.parse({ membership }));
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isInputError(error)) {
        throw new ApiError(400, "membership_required", "Invalid membership update");
      }
      throw new ApiError(503, "membership_unavailable", "Membership service unavailable");
    }
  };

  api.patch("/api/v1/accounts/:accountId/memberships/:userId", updateMembership);
  // Keep the earlier split paths as a migration alias; canonical clients use one PATCH body.
  api.patch("/api/v1/accounts/:accountId/memberships/:userId/role", updateMembership);
  api.patch("/api/v1/accounts/:accountId/memberships/:userId/status", updateMembership);

  api.delete("/api/v1/accounts/:accountId/memberships/:userId", async (context) => {
    try {
      return await withAccount(context, async (sessionHash, accountId, role, actorUserId) => {
        requireMembershipManager(role);
        const userId = assertUuid(context.req.param("userId"), "membership_required");
        const membership = assertSuccess(
          await dependencies.store.removeMembership({
            sessionHash,
            accountId,
            userId,
            audit: {
              accountId,
              actorUserId,
              action: "membership.removed",
              targetUserId: userId,
            },
          }),
        );
        return context.json(membershipMutationResponseSchema.parse({ membership }));
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isInputError(error)) {
        throw new ApiError(400, "membership_required", "Invalid membership update");
      }
      throw new ApiError(503, "membership_unavailable", "Membership service unavailable");
    }
  });
}
