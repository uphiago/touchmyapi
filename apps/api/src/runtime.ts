import {
  appendSystemAuditEvent,
  closeAuthDatabase,
  closeSystemAuditDatabase,
  closeTenantDatabase,
  createAuthDatabase,
  createSystemAuditDatabase,
  createTenantDatabase,
  resolveAuthSession,
  withTenant,
  withSystemAudit,
} from "@touchmyapi/db";
import { createApp, defaultLogger, type AuditSink } from "./app";
import { loadRuntimeConfig } from "./config";
import { createGitHubOAuthAdapter } from "./github-oauth-adapter";
import { createPostgresAssessmentStore } from "./postgres-assessment-store";
import { createPostgresAuthStore } from "./postgres-auth-store";
import { createPostgresMembershipStore } from "./postgres-membership-store";
import { createPostgresDeliveryStore } from "./postgres-delivery-store";
import { S3CompatiblePrivateReportStorage } from "@touchmyapi/reporting";

export type ApiRuntime = Readonly<{
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}>;

export async function createApiRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ApiRuntime> {
  const config = loadRuntimeConfig(env);
  const storageValues = [
    env.OBJECT_STORAGE_ENDPOINT,
    env.OBJECT_STORAGE_BUCKET,
    env.OBJECT_STORAGE_ACCESS_KEY_ID,
    env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  ].map((value) => value?.trim());
  if (storageValues.some(Boolean) && !storageValues.every(Boolean)) {
    throw new Error("private report storage configuration is incomplete");
  }
  const reportStorage = storageValues.every(Boolean)
    ? new S3CompatiblePrivateReportStorage({
        endpoint: storageValues[0]!,
        bucket: storageValues[1]!,
        region: env.OBJECT_STORAGE_REGION?.trim() || "auto",
        accessKeyId: storageValues[2]!,
        secretAccessKey: storageValues[3]!,
      })
    : undefined;
  const authDatabase = createAuthDatabase(config.authDatabaseUrl);
  const tenantDatabase = createTenantDatabase(config.apiDatabaseUrl);
  const auditDatabase = createSystemAuditDatabase(config.auditDatabaseUrl);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      closeAuthDatabase(authDatabase),
      closeTenantDatabase(tenantDatabase),
      closeSystemAuditDatabase(auditDatabase),
    ]);
  };

  try {
    // Establish and validate the least-privilege auth connector before serving.
    await resolveAuthSession(authDatabase, "0".repeat(64));
    await withTenant(tenantDatabase, "00000000-0000-4000-8000-000000000000", "api_rls", (context) =>
      context.account.readCurrent(),
    );
    await withSystemAudit(auditDatabase, (context) =>
      appendSystemAuditEvent(context, {
        actor: "customer_api",
        action: "request",
        payload: {
          event: "customer_api_runtime_preflight",
          requestId: crypto.randomUUID(),
        },
      }),
    );
    const authStore = createPostgresAuthStore(authDatabase);
    const auditSink: AuditSink = Object.freeze({
      record: async (record) => {
        await withSystemAudit(auditDatabase, (context) =>
          appendSystemAuditEvent(context, {
            actor: "customer_api",
            action: "request",
            payload: {
              event: "customer_api_request",
              requestId: record.requestId,
              ...record.payload,
            },
          }),
        );
      },
    });
    const githubAdapter = config.github
      ? createGitHubOAuthAdapter({
          clientId: config.github.clientId,
          clientSecret: config.github.clientSecret,
          redirectUri: config.github.callbackUrl,
        })
      : undefined;
    const auth = {
      store: authStore,
      ...(githubAdapter ? { githubAdapter } : {}),
      transientKey: config.authTransientKey,
      sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
      transientMaxAgeSeconds: config.transientMaxAgeSeconds,
      successRedirect: config.webAppOrigin,
      allowInsecureCookies: config.environment === "development",
    };
    return Object.freeze({
      app: createApp({
        config,
        logger: defaultLogger,
        auditSink,
        auth,
        membership: {
          store: createPostgresMembershipStore(authDatabase),
          resolveSession: authStore.resolveSession,
          allowInsecureCookies: config.environment === "development",
        },
        assessment: {
          store: createPostgresAssessmentStore(tenantDatabase),
          resolveSession: authStore.resolveSession,
          allowInsecureCookies: config.environment === "development",
        },
        delivery: {
          store: createPostgresDeliveryStore(tenantDatabase, reportStorage),
          resolveSession: authStore.resolveSession,
          allowInsecureCookies: config.environment === "development",
        },
      }),
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
