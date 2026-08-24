import {
  appendSystemAuditEvent,
  closeAuthDatabase,
  closeSystemAuditDatabase,
  closeTenantDatabase,
  createAuthDatabase,
  createSystemAuditDatabase,
  createTenantDatabase,
  resolveAuthSession,
  withSystemAudit,
} from "@touchmyapi/db";
import { createApp, defaultLogger, type AuditSink } from "./app";
import { loadRuntimeConfig } from "./config";
import { createGitHubOAuthAdapter } from "./github-oauth-adapter";
import { createPostgresAssessmentStore } from "./postgres-assessment-store";
import { createPostgresAuthStore } from "./postgres-auth-store";
import { createPostgresMembershipStore } from "./postgres-membership-store";

export type ApiRuntime = Readonly<{
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}>;

export async function createApiRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ApiRuntime> {
  const config = loadRuntimeConfig(env);
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
      }),
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
