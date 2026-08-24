import type { RawDbConnection } from "./connection-internal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type QueueBootstrapOptions = {
  readonly globalConcurrencyLimit?: number;
  readonly tenantConcurrencyLimit?: number;
};

/**
 * Upserts queue capacity state in the same connection/transaction as the
 * account bootstrap caller. It accepts only an already-authorized account id;
 * it never selects account or membership rows and never creates a tenant from
 * arbitrary user input.
 */
export async function ensureQueueState(
  db: RawDbConnection,
  accountId: string,
  options: QueueBootstrapOptions = {},
): Promise<void> {
  if (!UUID.test(accountId)) throw new TypeError("accountId must be a UUID");
  const globalLimit = options.globalConcurrencyLimit ?? 8;
  const tenantLimit = options.tenantConcurrencyLimit ?? 2;
  if (!Number.isInteger(globalLimit) || globalLimit < 1) {
    throw new RangeError("global concurrency limit must be positive");
  }
  if (!Number.isInteger(tenantLimit) || tenantLimit < 1) {
    throw new RangeError("tenant concurrency limit must be positive");
  }

  await db.begin(async (tx) => {
    await tx`
      insert into public.queue_global_state (id, running_count, concurrency_limit)
      values ('global', 0, ${globalLimit})
      on conflict (id) do update
        set concurrency_limit = excluded.concurrency_limit,
            updated_at = clock_timestamp()
    `;
    await tx`
      insert into public.queue_tenant_state (account_id, running_count, concurrency_limit)
      values (${accountId}, 0, ${tenantLimit})
      on conflict (account_id) do update
        set concurrency_limit = excluded.concurrency_limit,
            updated_at = clock_timestamp()
    `;
  });
}
