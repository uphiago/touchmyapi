import { z } from "zod";

const uuid = z.string().uuid();
const dateTime = z.string().datetime();
const nullableDateTime = dateTime.nullable();

export const queueStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale_recovered",
]);

export const outboxStatusSchema = z.enum(["pending", "processing", "processed", "failed"]);

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

export const queueGlobalStateSchema = z
  .object({
    id: z.literal("global"),
    runningCount: nonNegativeInt,
    concurrencyLimit: positiveInt,
    updatedAt: dateTime,
  })
  .strict();

export const queueTenantStateSchema = z
  .object({
    accountId: uuid,
    lastDispatchedAt: nullableDateTime,
    runningCount: nonNegativeInt,
    concurrencyLimit: positiveInt,
    updatedAt: dateTime,
  })
  .strict();

export const queueEnqueueRequestSchema = z
  .object({
    accountId: uuid,
    assessmentId: uuid,
    normalizedTargetKey: z.string().trim().min(1).max(512),
    priority: z.number().int().min(-100).max(100).default(0),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    availableAt: dateTime.optional(),
  })
  .strict();

export const queueJobOperationalSchema = z
  .object({
    id: uuid,
    accountId: uuid,
    status: queueStatusSchema,
    availableAt: dateTime,
    priority: z.number().int(),
    attempts: nonNegativeInt,
    maxAttempts: positiveInt,
    leaseOwner: z.string().max(128).nullable(),
    leaseExpiresAt: nullableDateTime,
    fencingToken: nonNegativeInt,
    startedAt: nullableDateTime,
    stopRequestedAt: nullableDateTime,
    failureReason: z.string().max(512).nullable(),
    createdAt: dateTime,
    normalizedTargetKey: z.string().max(512),
  })
  .strict();

export const outboxEventSchema = z
  .object({
    id: uuid,
    accountId: uuid,
    eventKey: z.string().min(1).max(255),
    aggregateType: z.string().min(1).max(64),
    aggregateId: uuid.nullable(),
    schemaVersion: z.string().min(1).max(64),
    status: outboxStatusSchema,
    attempts: nonNegativeInt,
    maxAttempts: positiveInt,
    availableAt: dateTime,
    leaseOwner: z.string().max(128).nullable(),
    leaseExpiresAt: nullableDateTime,
    fencingToken: nonNegativeInt,
    heartbeatAt: nullableDateTime,
    lastError: z.string().max(512).nullable(),
    failedAt: nullableDateTime,
    processedAt: nullableDateTime,
    createdAt: dateTime,
  })
  .strict();

export type QueueStatus = z.infer<typeof queueStatusSchema>;
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;
export type QueueEnqueueRequest = z.infer<typeof queueEnqueueRequestSchema>;
export type QueueGlobalState = z.infer<typeof queueGlobalStateSchema>;
export type QueueTenantState = z.infer<typeof queueTenantStateSchema>;
export type QueueJobOperational = z.infer<typeof queueJobOperationalSchema>;
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
