import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { errorResponseSchema, healthResponseSchema } from "@touchmyapi/contracts";
import { loadConfig, type ApiConfig } from "./config";
import { ApiError, errorEnvelope } from "./error";
import { getRequestId, requestIdMiddleware, type ApiRequestEnv } from "./request-id";

export type AuditRecord = Readonly<{
  action: "request";
  requestId: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type AuditSink = Readonly<{
  record: (record: AuditRecord) => Promise<void> | void;
}>;

export type ApiLogger = Readonly<{
  error?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
}>;

export type ApiDependencies = Readonly<{
  config: ApiConfig;
  logger: ApiLogger;
  auditSink: AuditSink;
}>;

type App = Hono<ApiRequestEnv>;

export const noopAuditSink: AuditSink = Object.freeze({ record: async () => undefined });
export const unavailableAuditSink: AuditSink = Object.freeze({
  record: async () => {
    throw new Error("audit sink unavailable");
  },
});
export const defaultLogger: ApiLogger = Object.freeze({
  error: (message, context) => console.error(message, context),
});

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function auditMiddleware(dependencies: ApiDependencies): MiddlewareHandler<ApiRequestEnv> {
  return async (context, next) => {
    const record: AuditRecord = {
      action: "request",
      requestId: getRequestId(context),
      payload: { method: context.req.method, route: "api.v1" },
    };
    try {
      await dependencies.auditSink.record(record);
    } catch {
      dependencies.logger.error?.("audit sink unavailable", { requestId: record.requestId });
      if (isMutation(context.req.method)) {
        const response = context.json(
          errorEnvelope("audit_unavailable", "Service Unavailable"),
          503,
        );
        context.res = response;
        return response;
      }
    }
    await next();
  };
}

export function createApp(dependencies: ApiDependencies): App {
  const api = new Hono<ApiRequestEnv>();
  api.use("*", requestIdMiddleware());
  api.use(
    "/health",
    cors({
      origin: dependencies.config.corsOrigin,
    }),
  );
  api.use("/api/v1/*", auditMiddleware(dependencies));
  api.use(
    "/api/v1/auth/*",
    cors({
      origin: dependencies.config.corsOrigin,
      credentials: true,
    }),
  );

  api.get("/health", (context) => {
    return context.json(healthResponseSchema.parse({ status: "ok" }));
  });

  api.notFound((context) => {
    return context.json(errorResponseSchema.parse(errorEnvelope("not_found", "Not Found")), 404);
  });

  api.onError((_error, context) => {
    dependencies.logger.error?.("unhandled request error", { requestId: getRequestId(context) });
    context.header("x-request-id", getRequestId(context));
    if (_error instanceof ApiError) {
      return context.json(errorEnvelope(_error.code, _error.message, _error.field), _error.status);
    }
    return context.json(errorEnvelope("internal_error", "Internal Server Error"), 500);
  });

  return api;
}

export const app = createApp({
  config: loadConfig(),
  logger: defaultLogger,
  auditSink: unavailableAuditSink,
});
