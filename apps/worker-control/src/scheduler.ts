import { claimQueueJob } from "../../../packages/db/src/queue-control";

type QueueDatabase = Parameters<typeof claimQueueJob>[0];

export async function claimNextQueueJob(
  db: QueueDatabase,
  workerId: string,
  leaseSeconds = 60,
  now = new Date(),
) {
  return claimQueueJob(db, workerId, leaseSeconds, now);
}
