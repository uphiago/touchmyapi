import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().datetime({ offset: true }).max(64);
const emailSchema = z.string().email().max(320);

export const membershipRoleSchema = z.enum(["owner", "admin", "operator", "viewer", "billing"]);
export const membershipStatusSchema = z.enum(["active", "suspended", "removed"]);
export const invitationStatusSchema = z.enum(["pending", "accepted", "expired", "revoked"]);

export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const membershipSchema = z
  .object({
    id: uuidSchema,
    accountId: uuidSchema,
    userId: uuidSchema,
    role: membershipRoleSchema,
    status: membershipStatusSchema,
    invitedByUserId: uuidSchema.nullable().optional(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    removedAt: isoDateSchema.nullable().optional(),
  })
  .strict();

export type Membership = z.infer<typeof membershipSchema>;

export const invitationCreateSchema = z
  .object({
    email: emailSchema,
    role: membershipRoleSchema,
    expiresAt: isoDateSchema,
  })
  .strict();

export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

/** The raw bearer token is accepted only in this explicit JSON body. */
export const invitationAcceptSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export type InvitationAccept = z.infer<typeof invitationAcceptSchema>;

/** Invitation records never contain the raw token or its reversible form. */
export const invitationSchema = z
  .object({
    id: uuidSchema,
    accountId: uuidSchema,
    email: emailSchema,
    proposedRole: membershipRoleSchema,
    status: invitationStatusSchema,
    expiresAt: isoDateSchema,
    acceptedAt: isoDateSchema.nullable().optional(),
    createdAt: isoDateSchema,
    invitedByUserId: uuidSchema,
    acceptedByUserId: uuidSchema.nullable().optional(),
  })
  .strict();

export type Invitation = z.infer<typeof invitationSchema>;

export const accountSummarySchema = z
  .object({
    accountId: uuidSchema,
    role: membershipRoleSchema,
    status: membershipStatusSchema,
    active: z.boolean(),
  })
  .strict();

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const accountListResponseSchema = z
  .object({
    accounts: z.array(accountSummarySchema).max(1000),
  })
  .strict();

export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

export const accountSwitchSchema = z
  .object({
    accountId: uuidSchema,
  })
  .strict();

export type AccountSwitch = z.infer<typeof accountSwitchSchema>;

export const membershipErrorCodeSchema = z.enum([
  "invalid_invitation",
  "membership_required",
  "membership_suspended",
  "active_account_required",
  "last_owner_protected",
]);

export type MembershipErrorCode = z.infer<typeof membershipErrorCodeSchema>;

export const membershipErrorSchema = z
  .object({
    error: z
      .object({
        code: membershipErrorCodeSchema,
        message: z.string().min(1).max(256),
        field: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export type MembershipError = z.infer<typeof membershipErrorSchema>;

// Explicit aliases keep request naming clear at API call sites while sharing
// one strict schema definition.
export const invitationCreateRequestSchema = invitationCreateSchema;
export const invitationAcceptRequestSchema = invitationAcceptSchema;
export const accountSwitchRequestSchema = accountSwitchSchema;
export const accountListSchema = accountListResponseSchema;
