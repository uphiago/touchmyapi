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
