import { z } from "zod";
import { assessmentStateSchema } from "./assessment";
import { redactedObjectSchema } from "./redacted";

const dateTimeSchema = z.string().datetime();
const severitySchema = z.enum(["info", "low", "medium", "high", "critical"]);
const countMapSchema = z.record(z.number().int().nonnegative());

const findingSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    bySeverity: countMapSchema,
    byCategory: countMapSchema,
  })
  .strict();

const maskedFindingSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(256),
    category: z.string().trim().min(1).max(128),
    severity: severitySchema,
  })
  .strict();

const detailedFindingSchema = maskedFindingSchema.extend({
  endpoint: z.string().trim().max(2048).nullable(),
  evidence: redactedObjectSchema.nullable(),
  reproduction: z.array(z.string().trim().min(1).max(1024)).max(20),
  impact: z.string().trim().max(4096).nullable(),
  remediation: z.string().trim().max(4096).nullable(),
});

const deliveryBase = {
  assessmentId: z.string().uuid(),
  status: assessmentStateSchema,
  summary: findingSummarySchema,
} as const;

export const assessmentDeliveryResponseSchema = z.discriminatedUnion("visibility", [
  z
    .object({
      ...deliveryBase,
      visibility: z.literal("aggregate"),
      findings: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...deliveryBase,
      visibility: z.literal("masked"),
      findings: z.array(maskedFindingSchema),
    })
    .strict(),
  z
    .object({
      ...deliveryBase,
      visibility: z.literal("detailed"),
      findings: z.array(detailedFindingSchema),
    })
    .strict(),
]);

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    assessmentId: z.string().uuid().nullable(),
    kind: z.enum(["assessment_completed", "assessment_failed"]),
    readAt: dateTimeSchema.nullable(),
    createdAt: dateTimeSchema,
  })
  .strict();

export const notificationListResponseSchema = z
  .object({
    notifications: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();

export const reportMetadataSchema = z
  .object({
    id: z.string().uuid(),
    assessmentId: z.string().uuid(),
    kind: z.enum(["pdf_technical", "pdf_executive", "json"]),
    contractVersion: z.string().trim().min(1).max(64),
    generatedAt: dateTimeSchema,
  })
  .strict();

export const reportListResponseSchema = z
  .object({ reports: z.array(reportMetadataSchema) })
  .strict();

export const reportDownloadResponseSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    expiresAt: dateTimeSchema,
  })
  .strict();

export type AssessmentDeliveryResponse = z.infer<typeof assessmentDeliveryResponseSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
export type ReportMetadata = z.infer<typeof reportMetadataSchema>;
export type ReportListResponse = z.infer<typeof reportListResponseSchema>;
export type ReportDownloadResponse = z.infer<typeof reportDownloadResponseSchema>;
