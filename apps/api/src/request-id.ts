import type { Context, MiddlewareHandler } from "hono";

export type ApiRequestEnv = {
  Variables: {
    requestId: string;
  };
};

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function getRequestId(context: Context<ApiRequestEnv>): string {
  return context.get("requestId");
}

export function requestIdMiddleware(): MiddlewareHandler<ApiRequestEnv> {
  return async (context, next) => {
    const requestId = newRequestId();
    context.set("requestId", requestId);
    try {
      await next();
    } finally {
      context.header("x-request-id", requestId);
    }
  };
}
