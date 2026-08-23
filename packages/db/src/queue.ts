import { queueEnqueueRequestSchema, type QueueEnqueueRequest } from "@touchmyapi/contracts";
import type { RawDbConnection } from "./connection-internal";

export class QueueUnavailableError extends Error {
  constructor() {
    super("queue_unavailable");
    this.name = "QueueUnavailableError";
  }
}

/**
 * Closed tenant enqueue boundary. The caller supplies a server-resolved
 * account id and assessment id; validation happens before the fixed-purpose
 * PostgreSQL function is called. No raw SQL or arbitrary table query is
 * exposed. The function is intentionally fail-closed until T082 installs the
 * transactional enqueue implementation.
 */
export async function enqueueJob(db: RawDbConnection, input: QueueEnqueueRequest): Promise<never> {
  const request = queueEnqueueRequestSchema.parse(input);
  const availableAt = request.availableAt ? new Date(request.availableAt) : new Date();
  await db`
    select app_private.queue_enqueue(
      ${request.accountId}::uuid,
      ${request.assessmentId}::uuid,
      ${availableAt},
      ${request.priority},
      ${request.maxAttempts}
    )
  `;
  throw new QueueUnavailableError();
}
