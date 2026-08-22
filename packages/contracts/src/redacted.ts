import { z } from "zod";

const secretKeyPattern = /secret|token|password|credential|authorization|api[_-]?key|cookie/i;

function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretKey);
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nestedValue]) => secretKeyPattern.test(key) || containsSecretKey(nestedValue),
    );
  }

  return false;
}

/**
 * Flexible, JSON-compatible metadata that is safe for public contracts.
 * Secret-bearing keys are rejected at every nesting level.
 */
export const redactedObjectSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (containsSecretKey(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Secret-bearing fields are not allowed in public contracts",
    });
  }
});

export type RedactedObject = z.infer<typeof redactedObjectSchema>;
