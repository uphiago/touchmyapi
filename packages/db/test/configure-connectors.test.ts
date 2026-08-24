import { describe, expect, it } from "vitest";
import { connectorCredentialPlan } from "../scripts/configure-connectors";

describe("production connector credential plan", () => {
  const migrationUrl = "postgres://migration:owner-secret@postgres:5432/touchmyapi";

  it("accepts only matching fixed-role URLs for the migrated database", () => {
    const plan = connectorCredentialPlan({
      DATABASE_URL: migrationUrl,
      AUTH_DATABASE_URL: "postgres://auth_connector:auth-secret-long@postgres:5432/touchmyapi",
      API_DATABASE_URL: "postgres://api_connector:api-secret-longer@postgres:5432/touchmyapi",
      AUDIT_DATABASE_URL:
        "postgres://audit_system_connector:audit-secret-long@postgres:5432/touchmyapi",
    });

    expect(plan.map(({ role }) => role)).toEqual([
      "auth_connector",
      "api_connector",
      "audit_system_connector",
    ]);
    expect(plan.map(({ password }) => password)).toEqual([
      "auth-secret-long",
      "api-secret-longer",
      "audit-secret-long",
    ]);
  });

  it("rejects missing passwords, wrong roles, and a different database boundary", () => {
    const valid = {
      DATABASE_URL: migrationUrl,
      AUTH_DATABASE_URL: "postgres://auth_connector:auth-secret-long@postgres:5432/touchmyapi",
      API_DATABASE_URL: "postgres://api_connector:api-secret-longer@postgres:5432/touchmyapi",
      AUDIT_DATABASE_URL:
        "postgres://audit_system_connector:audit-secret-long@postgres:5432/touchmyapi",
    };
    expect(() => connectorCredentialPlan({ ...valid, AUTH_DATABASE_URL: "" })).toThrow();
    expect(() =>
      connectorCredentialPlan({
        ...valid,
        API_DATABASE_URL: "postgres://postgres:api-secret-longer@postgres:5432/touchmyapi",
      }),
    ).toThrow();
    expect(() =>
      connectorCredentialPlan({
        ...valid,
        AUDIT_DATABASE_URL:
          "postgres://audit_system_connector:audit-secret-long@postgres:5432/other",
      }),
    ).toThrow();
  });
});
