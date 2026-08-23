import { claimOutboxEvents } from "../../../packages/db/src/queue-control";

type QueueDatabase = Parameters<typeof claimOutboxEvents>[0];

export async function claimOutboxBatch(
  db: QueueDatabase,
  workerId: string,
  batchSize = 25,
  now = new Date(),
) {
  return claimOutboxEvents(db, workerId, batchSize, now);
}
