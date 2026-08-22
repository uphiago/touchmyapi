import { z } from "zod";
import { redactedObjectSchema } from "./redacted";

/** Append-only, chainable audit record with a redacted payload. */
export const auditEventSchema = z
  .object({
    schemaVersion: z.literal("audit@1"),
    id: z.string().uuid(),
    prevId: z.string().uuid().nullable(),
    actor: z
      .object({ kind: z.enum(["user", "system", "webhook", "agent"]), id: z.string().nullable() })
      .strict(),
    action: z.enum([
      "request",
      "authz",
      "verify",
      "policy",
      "dispatch",
      "runner",
      "artifacts",
      "analyze",
      "publish",
      "download",
      "billing",
      "delete",
    ]),
    subject: z
      .object({ assessmentId: z.string().uuid().nullable(), jobId: z.string().uuid().nullable() })
      .strict(),
    payload: redactedObjectSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
