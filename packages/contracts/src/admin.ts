import { z } from "zod";

export const adminCapabilitySchema = z.enum(["queue.cancel", "queue.requeue", "queue.reap"]);
export const adminGrantStatusSchema = z.enum(["pending", "active", "denied", "expired"]);

export const adminStaffSessionSchema = z
  .object({
    staffId: z.string().min(3).max(80),
    email: z.string().email(),
    mode: z.literal("local-mock"),
  })
  .strict();

export const adminOperationsSchema = z
  .object({
    api: z.enum(["online", "degraded", "offline"]),
    database: z.enum(["online", "degraded", "offline"]),
    worker: z.enum(["mock-idle", "online", "degraded", "offline"]),
    queueDepth: z.number().int().min(0),
    oldestJobAgeSeconds: z.number().int().min(0),
    activeAlerts: z.number().int().min(0),
  })
  .strict();

export const adminAccountSummarySchema = z
  .object({
    accountId: z.string().uuid(),
    displayName: z.string().min(1).max(120),
    status: z.enum(["active", "suspended"]),
    plan: z.enum(["free_unverified", "verified", "pro"]),
    memberCount: z.number().int().min(0),
  })
  .strict();

export const adminQueueItemSchema = z
  .object({
    jobId: z.string().uuid(),
    accountId: z.string().uuid(),
    targetLabel: z.string().min(1).max(160),
    status: z.enum(["queued", "running", "stale"]),
    enqueuedAt: z.string().datetime(),
  })
  .strict();

export const adminGrantRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    capability: adminCapabilitySchema,
    ticket: z
      .string()
      .regex(/^[A-Z][A-Z0-9]+-[0-9]+$/)
      .max(40),
    reason: z.string().min(12).max(300),
    ttlSeconds: z.number().int().min(300).max(3600),
  })
  .strict();

export const adminGrantApprovalSchema = z
  .object({
    approverId: z.string().min(3).max(80),
    decision: z.enum(["approved", "denied"]),
  })
  .strict();

export const adminGrantSchema = adminGrantRequestSchema
  .extend({
    id: z.string().uuid(),
    requestedBy: z.string().min(3).max(80),
    approvedBy: z.string().min(3).max(80).nullable(),
    status: adminGrantStatusSchema,
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const adminQueueActionRequestSchema = z
  .object({
    grantId: z.string().uuid(),
    accountId: z.string().uuid(),
    action: adminCapabilitySchema,
    jobId: z.string().uuid().optional(),
    batchSize: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "queue.reap" && value.batchSize === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["batchSize"], message: "required" });
    }
    if (value.action !== "queue.reap" && value.jobId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["jobId"], message: "required" });
    }
  });

export const adminAuditEventSchema = z
  .object({
    id: z.string().uuid(),
    occurredAt: z.string().datetime(),
    actorId: z.string().min(3).max(80),
    action: z.enum(["grant.requested", "grant.approved", "grant.denied", "queue.action"]),
    accountId: z.string().uuid(),
    requestId: z.string().uuid(),
    summary: z.string().min(1).max(200),
  })
  .strict();

export const adminSnapshotSchema = z
  .object({
    session: adminStaffSessionSchema,
    operations: adminOperationsSchema,
    accounts: z.array(adminAccountSummarySchema),
    queue: z.array(adminQueueItemSchema),
    grants: z.array(adminGrantSchema),
    audit: z.array(adminAuditEventSchema),
    billing: z
      .object({
        mode: z.literal("read-only"),
        webhookStatus: z.enum(["mock-current", "current", "lagging"]),
      })
      .strict(),
  })
  .strict();

export type AdminCapability = z.infer<typeof adminCapabilitySchema>;
export type AdminGrantRequest = z.infer<typeof adminGrantRequestSchema>;
export type AdminGrant = z.infer<typeof adminGrantSchema>;
export type AdminQueueActionRequest = z.infer<typeof adminQueueActionRequestSchema>;
export type AdminAuditEvent = z.infer<typeof adminAuditEventSchema>;
export type AdminSnapshot = z.infer<typeof adminSnapshotSchema>;
