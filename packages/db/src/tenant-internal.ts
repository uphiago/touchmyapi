import type { TenantContext, RuntimeRole } from "./tenant-session";

type TenantBackend = {
  unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
};

export type ActiveTenantExecutor = {
  readonly backend: TenantBackend;
  readonly accountId: string;
  readonly role: RuntimeRole;
  active: boolean;
};

const activeExecutors = new WeakMap<object, ActiveTenantExecutor>();

export function activateTenantContext<R extends RuntimeRole>(
  context: TenantContext<R>,
  backend: TenantBackend,
  accountId: string,
  role: R,
): void {
  activeExecutors.set(context, { backend, accountId, role, active: true });
}

export function expireTenantContext(context: TenantContext): void {
  const active = activeExecutors.get(context);
  if (active) active.active = false;
}

/** Repository-only access to the reserved backend and canonical context data. */
export function getActiveTenantExecutor(context: TenantContext): ActiveTenantExecutor {
  const active = activeExecutors.get(context);
  if (!active || !active.active) {
    throw new Error("TenantContext is no longer active");
  }
  return active;
}
