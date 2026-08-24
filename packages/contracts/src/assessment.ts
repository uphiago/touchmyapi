import { z } from "zod";

/**
 * Persisted assessment states. Mirrors `assessment.status` in the data model
 * and is the single source of truth for the assessment state machine.
 */
export const assessmentStateSchema = z.enum([
  "draft",
  "awaiting_verification",
  "queued",
  "running",
  "analyzing",
  "completed",
  "failed",
  "cancelled",
]);

export type AssessmentState = z.infer<typeof assessmentStateSchema>;

/**
 * Target category. Mirrors `assessment.target_category` in the data model.
 */
export const targetCategorySchema = z.enum(["web", "api", "surface", "genai", "internal"]);

export type TargetCategory = z.infer<typeof targetCategorySchema>;

export const assessmentAuthorizationTermsVersion = "terms@1" as const;

export const assessmentAuthorizationSchema = z
  .object({
    accepted: z.literal(true),
    termsVersion: z.literal(assessmentAuthorizationTermsVersion),
  })
  .strict();

export const assessmentCreateSchema = z
  .object({
    targetCategory: targetCategorySchema,
    target: z.string().trim().min(1).max(2048),
    scope: z.array(z.string().trim().min(1).max(512)).max(100).default([]),
    playbookId: z.string().trim().min(1).max(128).default("surface-public-posture"),
    authorization: assessmentAuthorizationSchema,
  })
  .strict();

export const assessmentSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  targetCategory: targetCategorySchema,
  target: z.string(),
  scope: z.array(z.string()),
  playbookId: z.string(),
  playbookVersion: z.string(),
  status: assessmentStateSchema,
  jobId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const assessmentListResponseSchema = z.object({
  assessments: z.array(assessmentSchema),
});

export const assessmentMutationResponseSchema = z.object({
  assessment: assessmentSchema,
});

export type AssessmentCreate = z.infer<typeof assessmentCreateSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
