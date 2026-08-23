import { reconcileQueueState } from "../../../packages/db/src/queue-control";

type QueueDatabase = Parameters<typeof reconcileQueueState>[0];

export async function runQueueReconciliation(
  db: QueueDatabase,
  batchSize = 100,
  now = new Date(),
): Promise<number> {
  return reconcileQueueState(db, batchSize, now);
}
