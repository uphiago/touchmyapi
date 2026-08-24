import type { SystemAuditContext } from "./system-audit-session";

export type SystemAuditBackend = {
  unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
};

export type ActiveSystemAuditExecutor = {
  readonly backend: SystemAuditBackend;
  active: boolean;
};

const activeExecutors = new WeakMap<object, ActiveSystemAuditExecutor>();

export function activateSystemAuditContext(
  context: SystemAuditContext,
  backend: SystemAuditBackend,
): void {
  activeExecutors.set(context, { backend, active: true });
}

export function expireSystemAuditContext(context: SystemAuditContext): void {
  const active = activeExecutors.get(context);
  if (active) active.active = false;
}

export function getActiveSystemAuditExecutor(
  context: SystemAuditContext,
): ActiveSystemAuditExecutor {
  const active = activeExecutors.get(context);
  if (!active || !active.active) {
    throw new Error("SystemAuditContext is no longer active");
  }
  return active;
}
