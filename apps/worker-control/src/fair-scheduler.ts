export type FairTenant = {
  accountId: string;
  lastDispatchedAt: Date | null;
  runningCount: number;
  concurrencyLimit: number;
  queuedCount: number;
};

/**
 * Mirrors the database claim order. Fairness is deliberately explicit and
 * bounded: quiet tenants (never dispatched) come first, then oldest dispatch,
 * then account id. No deficit score or hidden weighting is introduced here.
 */
export function orderFairTenants(tenants: readonly FairTenant[]): FairTenant[] {
  return [...tenants].sort((left, right) => {
    if (left.lastDispatchedAt === null && right.lastDispatchedAt !== null) return -1;
    if (left.lastDispatchedAt !== null && right.lastDispatchedAt === null) return 1;
    if (left.lastDispatchedAt && right.lastDispatchedAt) {
      const byTime = left.lastDispatchedAt.getTime() - right.lastDispatchedAt.getTime();
      if (byTime !== 0) return byTime;
    }
    return left.accountId.localeCompare(right.accountId);
  });
}

export function selectFairTenant(
  tenants: readonly FairTenant[],
  globalRunning: number,
  globalLimit: number,
): FairTenant | null {
  if (
    !Number.isInteger(globalRunning) ||
    !Number.isInteger(globalLimit) ||
    globalRunning >= globalLimit
  ) {
    return null;
  }
  return (
    orderFairTenants(tenants).find(
      (tenant) => tenant.queuedCount > 0 && tenant.runningCount < tenant.concurrencyLimit,
    ) ?? null
  );
}
