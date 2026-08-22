import { z } from "zod";
import { redactedObjectSchema } from "./redacted";

const dateTimeSchema = z.string().datetime();

/** Public, plan-gated report export. It excludes credential and token fields. */
export const reportExportSchema = z
  .object({
    schemaVersion: z.literal("report.json@1"),
    assessmentId: z.string().uuid(),
    generatedAt: dateTimeSchema,
    plan: z.enum(["free_unverified", "free_verified", "pro", "lifetime"]),
    target: redactedObjectSchema,
    scope: z
      .object({
        inclusions: z.array(z.string()),
        exclusions: z.array(z.string()),
        window: z.object({ start: dateTimeSchema, end: dateTimeSchema }).strict(),
      })
      .strict(),
    playbook: z.object({ key: z.string(), version: z.string() }).strict(),
    methodology: z.array(z.string()),
    limitations: z.array(z.string()),
    findings: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          category: z.string(),
          severity: z.string(),
          evidence: redactedObjectSchema.optional(),
          reproduction: z.array(z.string()).optional(),
          impact: z.string().optional(),
          remediation: z.string().optional(),
        })
        .strict(),
    ),
    credits: z.object({ consumed: z.number(), estimate: z.number() }).strict(),
  })
  .strict();

export type ReportExport = z.infer<typeof reportExportSchema>;
