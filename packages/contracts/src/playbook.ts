import { z } from "zod";
import { targetCategorySchema } from "./assessment";

const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

const actionIdSchema = z.enum([
  "dns.records",
  "tls.cert",
  "http.headers",
  "robots.txt",
  "sitemap.xml",
  "endpoint.minimal",
]);

const nonNegativeNumberSchema = z.number().finite().nonnegative();

const actionSchema = z
  .object({
    id: actionIdSchema,
    type: z.enum([
      "http_probe",
      "dns_lookup",
      "tls_probe",
      "robots_fetch",
      "sitemap_fetch",
      "endpoint_probe",
    ]),
    allowedTargets: z.literal("scope"),
    method: z.literal("GET").optional(),
    limit: z
      .object({
        requests: nonNegativeNumberSchema,
        durationS: nonNegativeNumberSchema,
      })
      .strict(),
  })
  .strict();

/** Versioned policy contract that defines the only permitted runner actions. */
export const playbookSchema = z
  .object({
    schemaVersion: z.literal("playbook.schema@1"),
    key: z.string(),
    version: semverSchema,
    targetCategory: targetCategorySchema,
    active: z.boolean(),
    preconditions: z.array(z.object({ kind: z.string(), when: z.string() }).strict()),
    actions: z.array(actionSchema),
    limits: z
      .object({
        maxDurationS: nonNegativeNumberSchema,
        maxConcurrency: nonNegativeNumberSchema,
        maxRatePerMin: nonNegativeNumberSchema,
        egress: z
          .object({ allow: z.array(z.literal("scope_target")), blockDefaults: z.boolean() })
          .strict(),
        impactLevels: z.array(z.enum(["low", "medium", "high"])),
      })
      .strict(),
    stopSignals: z.array(
      z.enum(["scope_escape", "rate_exceeded", "unauthorized_endpoint", "duration_exceeded"]),
    ),
    evidence: z.object({ expected: z.array(z.string()), format: z.literal("manifest") }).strict(),
    severityPossible: z.array(z.enum(["info", "low", "medium", "high", "critical"])),
  })
  .strict();

export type Playbook = z.infer<typeof playbookSchema>;
