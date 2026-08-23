import type { Context, MiddlewareHandler } from "hono";

export type ApiRequestEnv = {
  Variables: {
    requestId: string;
  };
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function getRequestId(context: Context<ApiRequestEnv>): string {
  return context.get("requestId");
}

export function requestIdMiddleware(): MiddlewareHandler<ApiRequestEnv> {
  return async (context, next) => {
    const incoming = context.req.header("x-request-id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : newRequestId();
    context.set("requestId", requestId);
    try {
      await next();
    } finally {
      context.header("x-request-id", requestId);
    }
  };
}
