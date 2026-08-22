import { describe, expect, it } from "vitest";
import { billingEventSchema } from "../src/billing";

const billingEvent = {
  schemaVersion: "billing@1",
  stripeEventId: "evt_123",
  type: "checkout.session.completed",
  payloadMinimal: {
    customer: "cus_123",
    mode: "payment",
    amountTotal: 4900,
    currency: "brl",
    lineItems: [],
    subscriptionId: null,
  },
  processing: { status: "processed", result: { plan: "pro", credits: 10 } },
};

describe("billing event contract", () => {
  it("accepts a minimal processed Stripe webhook record", () => {
    expect(billingEventSchema.parse(billingEvent)).toEqual(billingEvent);
  });

  it("rejects unknown event types, processing states, and webhook secrets", () => {
    expect(() => billingEventSchema.parse({ ...billingEvent, type: "charge.refunded" })).toThrow();
    expect(() =>
      billingEventSchema.parse({ ...billingEvent, processing: { status: "retrying" } }),
    ).toThrow();
    expect(() =>
      billingEventSchema.parse({ ...billingEvent, webhookSecret: "never-here" }),
    ).toThrow();
  });
});
