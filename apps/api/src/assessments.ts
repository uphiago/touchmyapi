import {
  assessmentCreateSchema,
  assessmentListResponseSchema,
  assessmentMutationResponseSchema,
  type Assessment,
  type AssessmentCreate,
} from "../../../packages/contracts/src";
import type { Hono, Context } from "hono";
import { ApiError } from "./error";
import { hashSessionToken, readSessionToken, type AuthStore } from "./auth";
import type { ApiEnvironment } from "./config";
import type { ApiRequestEnv } from "./request-id";

export type AssessmentStore = Readonly<{
  list: (input: { sessionHash: string; accountId: string }) => Promise<readonly Assessment[]>;
  create: (input: {
    sessionHash: string;
    accountId: string;
    userId: string;
    request: AssessmentCreate;
  }) => Promise<Assessment>;
  queue: (input: {
    sessionHash: string;
    accountId: string;
    assessmentId: string;
  }) => Promise<Assessment | undefined>;
}>;

export type AssessmentDependencies = Readonly<{
  store: AssessmentStore;
  resolveSession: AuthStore["resolveSession"];
  allowInsecureCookies?: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function accountIdFrom(context: Context<ApiRequestEnv>): string {
  const accountId = context.req.param("accountId");
  if (!accountId || !UUID.test(accountId)) {
    throw new ApiError(400, "active_account_required", "Invalid account");
  }
  return accountId.toLowerCase();
}

async function sessionForAccount(
  context: Context<ApiRequestEnv>,
  dependencies: AssessmentDependencies,
  accountId: string,
  environment: ApiEnvironment,
): Promise<{ sessionHash: string; userId: string }> {
  const cookieName =
    dependencies.allowInsecureCookies === true && environment === "development"
      ? "tma-session"
      : "__Secure-tma-session";
  const token = readSessionToken(context.req.raw, cookieName);
  if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
  const sessionHash = await hashSessionToken(token);
  const session = await dependencies.resolveSession(sessionHash);
  if (!session || session.accountId !== accountId) {
    throw new ApiError(403, "active_account_required", "Active account required");
  }
  if (session.membershipStatus !== "active") {
    throw new ApiError(403, "membership_required", "Membership required");
  }
  return { sessionHash, userId: session.userId };
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

export function registerAssessmentRoutes(
  api: Hono<ApiRequestEnv>,
  dependencies: AssessmentDependencies,
  environment: ApiEnvironment = "production",
): void {
  api.get("/api/v1/accounts/:accountId/assessments", async (context) => {
    try {
      const accountId = accountIdFrom(context);
      const { sessionHash } = await sessionForAccount(
        context,
        dependencies,
        accountId,
        environment,
      );
      const assessments = await dependencies.store.list({ sessionHash, accountId });
      return context.json(assessmentListResponseSchema.parse({ assessments }));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "assessment_unavailable", "Assessment service unavailable");
    }
  });

  api.post("/api/v1/accounts/:accountId/assessments", async (context) => {
    try {
      const accountId = accountIdFrom(context);
      const { sessionHash, userId } = await sessionForAccount(
        context,
        dependencies,
        accountId,
        environment,
      );
      const request = assessmentCreateSchema.parse(await context.req.json());
      const assessment = await dependencies.store.create({
        sessionHash,
        accountId,
        userId,
        request,
      });
      return context.json(assessmentMutationResponseSchema.parse({ assessment }), 201);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isInputError(error)) throw new ApiError(400, "invalid_assessment", "Invalid assessment");
      throw new ApiError(503, "assessment_unavailable", "Assessment service unavailable");
    }
  });

  api.post("/api/v1/accounts/:accountId/assessments/:assessmentId/queue", async (context) => {
    try {
      const accountId = accountIdFrom(context);
      const { sessionHash } = await sessionForAccount(
        context,
        dependencies,
        accountId,
        environment,
      );
      const assessmentId = context.req.param("assessmentId");
      if (!assessmentId || !UUID.test(assessmentId)) {
        throw new ApiError(400, "invalid_assessment", "Invalid assessment");
      }
      const assessment = await dependencies.store.queue({
        sessionHash,
        accountId,
        assessmentId: assessmentId.toLowerCase(),
      });
      if (!assessment) throw new ApiError(404, "assessment_not_found", "Assessment not found");
      return context.json(assessmentMutationResponseSchema.parse({ assessment }));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "assessment_unavailable", "Assessment service unavailable");
    }
  });
}

export function createLocalAssessmentStore(): AssessmentStore {
  const byAccount = new Map<string, Assessment[]>();
  return {
    list: async ({ accountId }) => [...(byAccount.get(accountId) ?? [])],
    create: async ({ accountId, request }) => {
      const now = new Date().toISOString();
      const assessment: Assessment = {
        id: crypto.randomUUID(),
        accountId,
        targetCategory: request.targetCategory,
        target: request.target,
        scope: request.scope,
        playbookId: request.playbookId,
        playbookVersion: "1.0.0",
        status: "draft",
        jobId: null,
        createdAt: now,
        updatedAt: now,
      };
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), assessment]);
      return assessment;
    },
    queue: async ({ accountId, assessmentId }) => {
      const current = byAccount.get(accountId) ?? [];
      const index = current.findIndex((item) => item.id === assessmentId);
      const existing = current[index];
      if (
        !existing ||
        (existing.status !== "draft" && existing.status !== "awaiting_verification")
      ) {
        return undefined;
      }
      const updated: Assessment = {
        ...existing,
        status: "queued",
        jobId: existing.jobId ?? crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      const next = [...current];
      next[index] = updated;
      byAccount.set(accountId, next);
      return updated;
    },
  };
}
