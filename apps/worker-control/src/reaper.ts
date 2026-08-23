import { reapQueueJobs } from "../../../packages/db/src/queue-control";

type QueueDatabase = Parameters<typeof reapQueueJobs>[0];

export async function runQueueReaper(
  db: QueueDatabase,
  batchSize = 100,
  now = new Date(),
): Promise<number> {
  return reapQueueJobs(db, batchSize, now);
}
