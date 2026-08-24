import {
  adminGrantSchema,
  adminSnapshotSchema,
  type AdminCapability,
  type AdminGrant,
  type AdminSnapshot,
} from "@touchmyapi/contracts";

const baseUrl = import.meta.env.VITE_ADMIN_API_BASE_URL ?? "http://127.0.0.1:3001";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, credentials: "include" });
}

export async function bootstrapAdmin(): Promise<AdminSnapshot> {
  const session = await request("/api/v1/admin/auth/local-session", { method: "POST" });
  if (!session.ok) throw new Error("Staff session unavailable");
  return loadAdminSnapshot();
}

export async function loadAdminSnapshot(): Promise<AdminSnapshot> {
  const response = await request("/api/v1/admin/snapshot");
  if (!response.ok) throw new Error("Admin snapshot unavailable");
  return adminSnapshotSchema.parse(await response.json());
}

export async function requestGrant(input: {
  accountId: string;
  capability: AdminCapability;
  ticket: string;
  reason: string;
  ttlSeconds: number;
}): Promise<AdminGrant> {
  const response = await request("/api/v1/admin/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Grant request denied");
  return adminGrantSchema.parse(((await response.json()) as { grant: unknown }).grant);
}

export async function approveGrant(grantId: string): Promise<void> {
  const response = await request(`/api/v1/admin/grants/${grantId}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approverId: "local-approver", decision: "approved" }),
  });
  if (!response.ok) throw new Error("Distinct approval denied");
}

export async function performQueueAction(input: {
  grantId: string;
  accountId: string;
  capability: AdminCapability;
  jobId?: string;
}): Promise<void> {
  const response = await request("/api/v1/admin/queue/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantId: input.grantId,
      accountId: input.accountId,
      action: input.capability,
      ...(input.capability === "queue.reap" ? { batchSize: 10 } : { jobId: input.jobId }),
    }),
  });
  if (!response.ok) throw new Error("Bounded queue action denied");
}
