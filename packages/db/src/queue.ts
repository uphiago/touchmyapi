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
 * exposed. The PostgreSQL function inserts the operational job and outbox
 * intent atomically; worker claims remain behind queue-control.
 */
export async function enqueueJob(db: RawDbConnection, input: QueueEnqueueRequest): Promise<string> {
  const request = queueEnqueueRequestSchema.parse(input);
  const availableAt = request.availableAt ? new Date(request.availableAt) : new Date();
  const [row] = await db`
    select app_private.queue_enqueue(
      ${request.accountId}::uuid,
      ${request.assessmentId}::uuid,
      ${request.normalizedTargetKey},
      ${availableAt},
      ${request.priority},
      ${request.maxAttempts}
    )
  `;
  const jobId = row?.queue_enqueue as string | null | undefined;
  if (!jobId) throw new QueueUnavailableError();
  return jobId;
}
