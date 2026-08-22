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
