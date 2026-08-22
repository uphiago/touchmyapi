import { z } from "zod";

/** Minimal, idempotent Stripe webhook record; it is not an entitlement mutation. */
export const billingEventSchema = z
  .object({
    schemaVersion: z.literal("billing@1"),
    stripeEventId: z.string(),
    type: z.enum([
      "checkout.session.completed",
      "checkout.session.expired",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ]),
    payloadMinimal: z
      .object({
        customer: z.string(),
        mode: z.enum(["payment", "subscription"]),
        amountTotal: z.number(),
        currency: z.string(),
        lineItems: z.array(z.unknown()),
        subscriptionId: z.string().nullable(),
      })
      .strict(),
    processing: z
      .object({
        status: z.enum(["received", "processed", "failed"]),
        result: z.object({ plan: z.string(), credits: z.number() }).strict().optional(),
      })
      .strict(),
  })
  .strict();

export type BillingEvent = z.infer<typeof billingEventSchema>;
