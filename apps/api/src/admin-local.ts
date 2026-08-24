import {
  adminGrantApprovalSchema,
  adminGrantRequestSchema,
  adminQueueActionRequestSchema,
  adminSnapshotSchema,
  type AdminAuditEvent,
  type AdminGrant,
} from "@touchmyapi/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";

const ADMIN_COOKIE = "tma-admin-session";
const LOCAL_ADMIN_TOKEN = "A".repeat(43);
const STAFF_ID = "local-operator";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000101";
const JOB_ID = "00000000-0000-4000-8000-000000000201";

type Options = Readonly<{ corsOrigin: string }>;

function jsonError(
  context: Parameters<Parameters<Hono["onError"]>[0]>[1],
  status: 400 | 401 | 403 | 404 | 409,
  code: string,
) {
  return context.json({ error: { code, message: code.replaceAll("_", " ") } }, status);
}

export function createLocalAdminApp(options: Options) {
  const app = new Hono();
  const grants = new Map<string, AdminGrant>();
  const audit: AdminAuditEvent[] = [];

  app.use(
    "/api/v1/admin/*",
    cors({
      origin: options.corsOrigin,
      credentials: true,
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/health", (context) => context.json({ status: "ok", boundary: "admin" }));
  app.post("/api/v1/admin/auth/local-session", (context) => {
    setCookie(context, ADMIN_COOKIE, LOCAL_ADMIN_TOKEN, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: false,
      maxAge: 3600,
    });
    return context.json({
      session: { staffId: STAFF_ID, email: "local.operator@example.test", mode: "local-mock" },
    });
  });

  app.use("/api/v1/admin/*", async (context, next) => {
    if (getCookie(context, ADMIN_COOKIE) !== LOCAL_ADMIN_TOKEN) {
      return jsonError(context, 401, "staff_session_required");
    }
    await next();
  });

  const snapshot = () =>
    adminSnapshotSchema.parse({
      session: { staffId: STAFF_ID, email: "local.operator@example.test", mode: "local-mock" },
      operations: {
        api: "online",
        database: "online",
        worker: "mock-idle",
        queueDepth: 1,
        oldestJobAgeSeconds: 84,
        activeAlerts: 0,
      },
      accounts: [
        {
          accountId: ACCOUNT_ID,
          displayName: "Local authorized workspace",
          status: "active",
          plan: "free_unverified",
          memberCount: 1,
        },
      ],
      queue: [
        {
          jobId: JOB_ID,
          accountId: ACCOUNT_ID,
          targetLabel: "redacted local target",
          status: "queued",
          enqueuedAt: "2026-08-23T12:00:00.000Z",
        },
      ],
      grants: [...grants.values()],
      audit,
      billing: { mode: "read-only", webhookStatus: "mock-current" },
    });

  app.get("/api/v1/admin/snapshot", (context) => context.json(snapshot()));

  app.post("/api/v1/admin/grants", async (context) => {
    const parsed = adminGrantRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return jsonError(context, 400, "invalid_grant_request");
    const now = new Date();
    const grant = {
      id: crypto.randomUUID(),
      ...parsed.data,
      requestedBy: STAFF_ID,
      approvedBy: null,
      status: "pending" as const,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parsed.data.ttlSeconds * 1000).toISOString(),
    } satisfies AdminGrant;
    grants.set(grant.id, grant);
    audit.unshift({
      id: crypto.randomUUID(),
      occurredAt: now.toISOString(),
      actorId: STAFF_ID,
      action: "grant.requested",
      accountId: grant.accountId,
      requestId: crypto.randomUUID(),
      summary: `${grant.capability} requested for ${grant.ticket}`,
    });
    return context.json({ grant }, 201);
  });

  app.post("/api/v1/admin/grants/:grantId/approval", async (context) => {
    const grant = grants.get(context.req.param("grantId"));
    if (!grant) return jsonError(context, 404, "grant_not_found");
    const parsed = adminGrantApprovalSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return jsonError(context, 400, "invalid_approval");
    if (parsed.data.approverId === grant.requestedBy) {
      return jsonError(context, 409, "distinct_approver_required");
    }
    if (grant.status !== "pending") return jsonError(context, 409, "grant_not_pending");
    const updated: AdminGrant = {
      ...grant,
      approvedBy: parsed.data.approverId,
      status: parsed.data.decision === "approved" ? "active" : "denied",
    };
    grants.set(updated.id, updated);
    audit.unshift({
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      actorId: parsed.data.approverId,
      action: parsed.data.decision === "approved" ? "grant.approved" : "grant.denied",
      accountId: updated.accountId,
      requestId: crypto.randomUUID(),
      summary: `${updated.capability} ${parsed.data.decision}`,
    });
    return context.json({ grant: updated });
  });

  app.post("/api/v1/admin/queue/actions", async (context) => {
    const parsed = adminQueueActionRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return jsonError(context, 400, "invalid_queue_action");
    const grant = grants.get(parsed.data.grantId);
    if (
      !grant ||
      grant.status !== "active" ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      grant.accountId !== parsed.data.accountId ||
      grant.capability !== parsed.data.action
    ) {
      return jsonError(context, 403, "active_matching_grant_required");
    }
    audit.unshift({
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      actorId: STAFF_ID,
      action: "queue.action",
      accountId: parsed.data.accountId,
      requestId: crypto.randomUUID(),
      summary: `${parsed.data.action} accepted in local simulation`,
    });
    return context.json({
      result: { status: "accepted", simulated: true, action: parsed.data.action },
    });
  });

  app.notFound((context) => jsonError(context, 404, "not_found"));
  return app;
}
