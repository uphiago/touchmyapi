import { getActiveTenantExecutor } from "./tenant-internal";
import type { RuntimeRole, TenantContext } from "./tenant-session";

export type TenantAccount = {
  readonly id: string;
  readonly status: string;
  readonly settings_ia_enabled: boolean;
  readonly created_at: Date;
  readonly deleted_at: Date | null;
};

export type TenantAccountCapability<R extends RuntimeRole = RuntimeRole> = Readonly<{
  readCurrent(): Promise<TenantAccount | null>;
}> &
  (R extends "api_rls" ? { setIaEnabled(enabled: boolean): Promise<void> } : object);

/** The only account operation exposed to a tenant callback in T016. */
export function createTenantAccountCapability<R extends RuntimeRole>(
  context: TenantContext<R>,
): TenantAccountCapability<R> {
  const capability: {
    readCurrent(): Promise<TenantAccount | null>;
    setIaEnabled?: (enabled: boolean) => Promise<void>;
  } = {
    readCurrent: async (): Promise<TenantAccount | null> => {
      const { backend, accountId } = getActiveTenantExecutor(context);
      const rows = await backend.unsafe(
        "select id, status, settings_ia_enabled, created_at, deleted_at from public.account where id = $1::uuid",
        [accountId],
      );
      return (rows[0] as TenantAccount | undefined) ?? null;
    },
  };
  if (context.role === "api_rls") {
    capability.setIaEnabled = async (enabled: boolean): Promise<void> => {
      const { backend, accountId } = getActiveTenantExecutor(context);
      const rows = await backend.unsafe(
        "update public.account set settings_ia_enabled = $1 where id = $2::uuid and status = 'active' and deleted_at is null returning id",
        [enabled, accountId],
      );
      if (rows.length === 0) throw new Error("active tenant account required");
    };
  }
  return Object.freeze(capability) as TenantAccountCapability<R>;
}
