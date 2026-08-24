import { lookup } from "node:dns/promises";
import {
  appendAuditEvent,
  createAssessment,
  listAssessments,
  queueAssessment,
  readAssessmentPolicySnapshot,
  withTenant,
  type TenantDatabase,
} from "@touchmyapi/db";
import { surfacePublicPosture } from "@touchmyapi/playbooks";
import {
  authorize,
  compileScope,
  createPolicyContext,
  createPolicyEntitlement,
} from "@touchmyapi/policy";
import type { AssessmentStore } from "./assessments";

export class AssessmentPolicyDeniedError extends Error {
  readonly blocked: readonly string[];

  constructor(blocked: readonly string[]) {
    super("assessment_policy_denied");
    this.name = "AssessmentPolicyDeniedError";
    this.blocked = [...blocked];
  }
}

export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

async function defaultAddressResolver(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function externalUrl(target: string): URL {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(target) ? target : `https://${target}`;
  const url = new URL(candidate);
  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new TypeError("invalid external target");
  }
  return url;
}

export function createPostgresAssessmentStore(
  database: TenantDatabase,
  resolveAddresses: AddressResolver = defaultAddressResolver,
): AssessmentStore {
  return {
    list: ({ accountId }) =>
      withTenant(database, accountId, "api_rls", (context) => listAssessments(context)),
    create: ({ accountId, userId, request }) =>
      withTenant(database, accountId, "api_rls", async (context) => {
        const assessment = await createAssessment(context, { userId, request });
        await appendAuditEvent(context, {
          actor: userId,
          action: "authz",
          assessmentId: assessment.id,
          payload: {
            event: "assessment_authorized_draft_created",
            termsVersion: request.authorization.termsVersion,
            playbookId: assessment.playbookId,
          },
        });
        return assessment;
      }),
    queue: async ({ accountId, assessmentId, userId }) => {
      const snapshot = await withTenant(database, accountId, "api_rls", (context) =>
        readAssessmentPolicySnapshot(context, assessmentId),
      );
      if (!snapshot || snapshot.assessment.status !== "draft") return undefined;
      const targetUrl = externalUrl(snapshot.assessment.target);
      const inclusions =
        snapshot.assessment.scope.length > 0
          ? snapshot.assessment.scope
          : [snapshot.assessment.target];
      const scope = compileScope({ inclusions, exclusions: [] });
      const evaluatedAt = new Date().toISOString();
      const context = createPolicyContext(
        {
          accountId,
          assessmentId,
          userId: snapshot.attestedByUserId,
          evaluatedAt,
        },
        scope,
      );
      const entitlement = createPolicyEntitlement(
        {
          plan: "free_unverified",
          source: "baseline",
          sourceId: null,
          grantedAt: snapshot.acceptedAt,
          expiresAt: null,
        },
        context,
      );
      const decision = authorize({
        context,
        action: "passive_external",
        targetCategory: snapshot.assessment.targetCategory,
        target: {
          candidate: targetUrl.toString(),
          resolvedAddresses: await resolveAddresses(targetUrl.hostname),
        },
        scope,
        entitlement,
        limits: {
          playbook: {
            durationS: 300,
            concurrency: 1,
            ratePerMin: 10,
            credits: 1,
            egress: ["scope_target"],
          },
          entitlement: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
          account: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
          global: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
        },
        attestation: {
          version: snapshot.termsVersion,
          accountId,
          assessmentId,
          userId: snapshot.attestedByUserId,
          target: targetUrl.toString(),
          scopeFingerprint: context.scopeFingerprint,
          playbookKey: snapshot.assessment.playbookId,
          playbookVersion: snapshot.assessment.playbookVersion,
          acceptedAt: snapshot.acceptedAt,
        },
        verification: null,
        playbook: surfacePublicPosture,
      });
      if (!decision.allowed) {
        throw new AssessmentPolicyDeniedError(decision.blocked.map((block) => block.code));
      }
      return withTenant(database, accountId, "api_rls", async (tenantContext) => {
        const assessment = await queueAssessment(tenantContext, { assessmentId });
        if (assessment?.jobId) {
          await appendAuditEvent(tenantContext, {
            actor: userId,
            action: "dispatch",
            assessmentId,
            jobId: assessment.jobId,
            payload: {
              event: "passive_assessment_queued",
              policy: "allowed",
              playbookId: assessment.playbookId,
              playbookVersion: assessment.playbookVersion,
            },
          });
        }
        return assessment;
      });
    },
  };
}
