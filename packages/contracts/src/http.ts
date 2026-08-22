import { z } from "zod";

/**
 * Public HTTP health response. Exposes only liveness, never secrets,
 * entitlements, credentials, or raw runner output.
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Public HTTP error envelope, per `contracts/api.md`:
 * `{ "error": { "code", "message", "field?" } }`.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
