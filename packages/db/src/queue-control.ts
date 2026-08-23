import type { RawDbConnection } from "./connection-internal";

const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export type QueueClaim = {
  readonly jobId: string;
  readonly accountId: string;
  readonly status: "running";
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
  readonly fencingToken: number;
};

export type QueueHeartbeat = QueueClaim;

export async function claimQueueJob(
  db: RawDbConnection,
  workerId: string,
  leaseSeconds = 60,
  now = new Date(),
): Promise<QueueClaim | null> {
  if (!WORKER_ID.test(workerId)) throw new TypeError("workerId is invalid");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
    throw new RangeError("leaseSeconds must be between 1 and 900");
  }
  const [row] = await db`
    select app_private.queue_claim(${workerId}, ${leaseSeconds}, ${now})
  `;
  const value = row?.queue_claim as QueueClaim | null | undefined;
  return value ?? null;
}

export async function heartbeatQueueJob(
  db: RawDbConnection,
  accountId: string,
  jobId: string,
  workerId: string,
  fencingToken: number,
  leaseSeconds = 60,
  now = new Date(),
): Promise<QueueHeartbeat | null> {
  validateLeaseInput(workerId, fencingToken, leaseSeconds);
  const [row] = await db`
    select app_private.queue_heartbeat(
      ${accountId}::uuid, ${jobId}::uuid, ${workerId},
      ${fencingToken}::bigint, ${leaseSeconds}, ${now}
    )
  `;
  return (row?.queue_heartbeat as QueueHeartbeat | null | undefined) ?? null;
}

export async function completeQueueJob(
  db: RawDbConnection,
  accountId: string,
  jobId: string,
  workerId: string,
  fencingToken: number,
  resultMetadata: Record<string, unknown> = {},
): Promise<QueueHeartbeat | null> {
  validateLeaseInput(workerId, fencingToken, 1);
  const [row] = await db`
    select app_private.queue_complete(
      ${accountId}::uuid, ${jobId}::uuid, ${workerId},
      ${fencingToken}::bigint, ${JSON.stringify(resultMetadata)}::jsonb
    )
  `;
  return (row?.queue_complete as QueueHeartbeat | null | undefined) ?? null;
}

export async function failQueueJob(
  db: RawDbConnection,
  accountId: string,
  jobId: string,
  workerId: string,
  fencingToken: number,
  reason: string,
): Promise<QueueHeartbeat | null> {
  validateLeaseInput(workerId, fencingToken, 1);
  if (
    !reason.trim() ||
    reason.length > 512 ||
    reason.includes(String.fromCharCode(10)) ||
    reason.includes(String.fromCharCode(13))
  ) {
    throw new TypeError("failure reason is invalid");
  }
  const [row] = await db`
    select app_private.queue_fail(
      ${accountId}::uuid, ${jobId}::uuid, ${workerId},
      ${fencingToken}::bigint, ${reason}
    )
  `;
  return (row?.queue_fail as QueueHeartbeat | null | undefined) ?? null;
}

export async function reapQueueJobs(
  db: RawDbConnection,
  batchSize: number,
  now = new Date(),
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("batchSize must be between 1 and 100");
  }
  const [row] = await db`
    select app_private.queue_reap(${batchSize}, ${now})
  `;
  return Number(row?.queue_reap ?? 0);
}

function validateLeaseInput(workerId: string, fencingToken: number, leaseSeconds: number): void {
  if (!WORKER_ID.test(workerId)) throw new TypeError("workerId is invalid");
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 0) {
    throw new TypeError("fencingToken is invalid");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) {
    throw new RangeError("leaseSeconds must be between 1 and 900");
  }
}
