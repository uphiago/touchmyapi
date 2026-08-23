import { errorResponseSchema } from "@touchmyapi/contracts";

export function errorEnvelope(code: string, message: string, field?: string) {
  return errorResponseSchema.parse({
    error: { code, message, ...(field === undefined ? {} : { field }) },
  });
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 409 | 503;
  readonly field?: string;

  constructor(status: ApiError["status"], code: string, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
