import { z } from "zod";
import { redactedObjectSchema } from "./redacted";

const dateTimeSchema = z.string().datetime();

const scopeSchema = z
  .object({
    inclusions: z.array(z.string()),
    exclusions: z.array(z.string()),
    window: z.object({ start: dateTimeSchema, end: dateTimeSchema }).strict(),
  })
  .strict();

const limitsSchema = z
  .object({
    maxDurationS: z.number(),
    maxConcurrency: z.number(),
    maxRatePerMin: z.number(),
    egress: z.object({ allow: z.array(z.string()), blockDefaults: z.boolean() }).strict(),
  })
  .strict();

/** Signed, capability-limited dispatch unit between the control worker and runner. */
export const jobSpecSchema = z
  .object({
    schemaVersion: z.literal("job.spec@1"),
    jobId: z.string().uuid(),
    assessmentId: z.string().uuid(),
    playbook: z.object({ key: z.string(), version: z.string() }).strict(),
    target: redactedObjectSchema,
    scope: scopeSchema,
    actions: z.array(z.string()),
    limits: limitsSchema,
    capabilities: z.array(z.enum(["http_client", "dns_resolver", "tls_probe"])),
    ttl: dateTimeSchema,
    issuedAt: dateTimeSchema,
    issuer: z.string(),
    signature: z.object({ alg: z.literal("Ed25519"), value: z.string() }).strict(),
  })
  .strict();

/** Redacted, hash-addressed result manifest emitted by the runner. */
export const artifactManifestSchema = z
  .object({
    schemaVersion: z.literal("job.artifacts@1"),
    jobId: z.string().uuid(),
    finishedAt: dateTimeSchema,
    exit: z.object({ code: z.number(), signal: z.string().nullable() }).strict(),
    limitsUsed: z.object({ cpuS: z.number(), memMB: z.number(), durationS: z.number() }).strict(),
    artifacts: z.array(
      z
        .object({ path: z.string(), sha256: z.string(), size: z.number(), kind: z.string() })
        .strict(),
    ),
    output: z
      .object({ summary: z.string().max(8192).optional(), truncated: z.boolean().optional() })
      .strict()
      .optional(),
    stopsTriggered: z.array(z.string()),
    cleanup: z.object({ containerRemoved: z.boolean(), tmpfsRemoved: z.boolean() }).strict(),
  })
  .strict();

export type JobSpec = z.infer<typeof jobSpecSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
