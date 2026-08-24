import * as contracts from "../src";
import { describe, expect, it } from "vitest";

const accountId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";

describe("authentication contracts", () => {
  it("publishes only the enabled GitHub provider metadata", () => {
    const schema = Reflect.get(contracts, "authProvidersResponseSchema") as
      { parse(value: unknown): unknown } | undefined;

    expect(schema).toBeDefined();
    expect(schema?.parse({ providers: [{ id: "github", label: "GitHub" }] })).toEqual({
      providers: [{ id: "github", label: "GitHub" }],
    });
    expect(() => schema?.parse({ providers: [{ id: "google", label: "Google" }] })).toThrow();
  });

  it("accepts only a sanitized authenticated session", () => {
    const schema = Reflect.get(contracts, "authSessionResponseSchema") as
      { parse(value: unknown): unknown } | undefined;
    const session = {
      user: { id: userId, email: "owner@example.test" },
      account: {
        id: accountId,
        role: "owner",
        plan: "free_unverified",
        iaEnabled: true,
      },
    };

    expect(schema).toBeDefined();
    expect(schema?.parse(session)).toEqual(session);
    expect(() => schema?.parse({ ...session, sessionToken: "secret" })).toThrow();
  });
});
