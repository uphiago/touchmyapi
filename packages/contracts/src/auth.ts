import { z } from "zod";
import { membershipRoleSchema } from "./membership";

const uuidSchema = z.string().uuid();

export const authProviderSchema = z
  .object({
    id: z.literal("github"),
    label: z.literal("GitHub"),
  })
  .strict();

export const authProvidersResponseSchema = z
  .object({
    providers: z.array(authProviderSchema).max(1),
  })
  .strict();

export const authSessionResponseSchema = z
  .object({
    user: z
      .object({
        id: uuidSchema,
        email: z.string().email().max(320),
      })
      .strict(),
    account: z
      .object({
        id: uuidSchema,
        role: membershipRoleSchema,
        plan: z.string().min(1).max(64),
        iaEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AuthProvider = z.infer<typeof authProviderSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
