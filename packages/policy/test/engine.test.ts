import { describe, expect, it } from "vitest";
import { authorize, type ActionRequest } from "../src/engine";
import { compileScope } from "../src/scope";

const scope = compileScope({ inclusions: ["example.com"], exclusions: [] });

const limits = () => ({
  playbook: {
    durationS: 300,
    concurrency: 1,
    ratePerMin: 10,
    credits: 1,
    egress: ["scope_target"] as const,
  },
  entitlement: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
  account: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
  global: { durationS: 300, concurrency: 1, ratePerMin: 10, credits: 1 },
});

const playbook = (
  actionIds: readonly string[] = [
    "dns.records",
    "tls.cert",
    "http.headers",
    "robots.txt",
    "sitemap.xml",
    "endpoint.minimal",
  ],
) => ({
  schemaVersion: "playbook.schema@1" as const,
  key: "surface-public-posture" as const,
  version: "1.0.0" as const,
  targetCategory: "surface" as const,
  active: true,
  preconditions: [{ kind: "http_verification_required", when: "active_external" }],
  actions: actionIds.map((id) => ({
    id,
    type: ACTION_TYPES[id as keyof typeof ACTION_TYPES] ?? "unknown",
    allowedTargets: "scope" as const,
    ...(id === "http.headers" ||
    id === "robots.txt" ||
    id === "sitemap.xml" ||
    id === "endpoint.minimal"
      ? { method: "GET" }
      : {}),
    limit: { requests: 1, durationS: 30 },
  })),
  limits: {
    maxDurationS: 300,
    maxConcurrency: 1,
    maxRatePerMin: 10,
    egress: { allow: ["scope_target" as const], blockDefaults: true },
    impactLevels: ["info", "low"],
  },
  stopSignals: ["scope_escape", "rate_exceeded", "unauthorized_endpoint", "duration_exceeded"],
  evidence: { expected: ["public_posture"], format: "manifest" as const },
  severityPossible: ["info", "low"],
});

const ACTION_TYPES = {
  "dns.records": "dns_lookup",
  "tls.cert": "tls_probe",
  "http.headers": "http_probe",
  "robots.txt": "robots_fetch",
  "sitemap.xml": "sitemap_fetch",
  "endpoint.minimal": "endpoint_probe",
} as const;

const valid = (overrides: Record<string, unknown> = {}): ActionRequest => ({
  action: "passive_external",
  targetCategory: "surface",
  target: { candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
  scope,
  entitlement: "free_unverified",
  limits: limits(),
  attestation: { version: "terms@1" },
  verification: null,
  playbook: playbook(),
  ...overrides,
});

describe("authorize", () => {
  it("allows a passive free-unverified assessment and derives actions", () => {
    const result = authorize(valid());
    expect(result).toMatchObject({ allowed: true, blocked: [], reason: "allowed" });
    expect(result.actions).toEqual([
      "dns.records",
      "tls.cert",
      "http.headers",
      "robots.txt",
      "sitemap.xml",
      "endpoint.minimal",
    ]);
    expect(result.capabilities).toEqual(["dns_resolver", "tls_probe", "http_client"]);
    expect(result.limits).toEqual({
      durationS: 300,
      concurrency: 1,
      ratePerMin: 10,
      credits: 1,
      egress: ["scope_target"],
    });
  });

  it("allows active verified assessments only for plans with active rights", () => {
    const result = authorize(
      valid({
        action: "active_external",
        entitlement: "free_verified",
        verification: { method: "http_file", status: "verified" },
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("denies DNS TXT verification for active execution", () => {
    const result = authorize(
      valid({
        action: "active_external",
        entitlement: "pro",
        verification: { method: "dns_txt", status: "verified" },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((block) => block.code)).toContain("verification_method_not_allowed");
  });

  it("runs every applicable check in stable order and strips execution outputs on denial", () => {
    const result = authorize(
      valid({
        action: "unknown",
        targetCategory: "unknown",
        target: { candidate: "https://example.com:8443/", resolvedAddresses: ["10.0.0.1"] },
        entitlement: "unknown",
        attestation: null,
        verification: { method: "dns_txt", status: "pending" },
        playbook: playbook(["not-allowed"]),
        actions: ["http.headers"],
        capabilities: ["http_client"],
        commands: ["curl"],
        limits: { ...limits(), requested: { durationS: 0 } },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.capabilities).toEqual([]);
    expect(result.limits).toBeNull();
    expect(result.reason).toBe("assessment blocked by policy");
    expect(result.blocked.map((block) => block.code)).toEqual([
      "unknown_action",
      "unknown_target_category",
      "unknown_plan",
      "port_not_allowed",
      "forbidden_target",
      "attestation_required",
      "verification_method_not_allowed",
      "target_category_mismatch",
      "caller_execution_fields_not_allowed",
      "invalid_limits",
    ]);
  });

  it("rejects forged scopes and malformed input without throwing", () => {
    const forged = { inclusions: scope.inclusions, exclusions: scope.exclusions };
    expect(() => authorize(valid({ scope: forged }))).not.toThrow();
    expect(authorize(valid({ scope: forged })).allowed).toBe(false);
    for (const input of [
      null,
      undefined,
      [],
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error();
          },
        },
      ),
    ]) {
      expect(() => authorize(input as never)).not.toThrow();
      expect(authorize(input as never).allowed).toBe(false);
    }
  });

  it("deep freezes successful decisions and never mutates input", () => {
    const input = valid();
    const result = authorize(input);
    expect(result.allowed).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.actions)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.limits)).toBe(true);
    expect(Object.isFrozen(result.limits?.egress)).toBe(true);
    expect(input.action).toBe("passive_external");
  });

  it.each([
    ["missing preconditions", { ...playbook(), preconditions: undefined }],
    ["missing limits", { ...playbook(), limits: undefined }],
    ["missing evidence", { ...playbook(), evidence: undefined }],
    ["string action compatibility", { ...playbook(), actions: ["dns.records"] }],
  ])("rejects incomplete playbook facts (%s)", (_name, incomplete) => {
    const result = authorize(valid({ playbook: incomplete }));
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((block) => block.code)).toContain("invalid_playbook");
  });

  it("rejects resolved address accessors and proxies without throwing", () => {
    const addressProxy = new Proxy(["8.8.8.8"], {
      get() {
        throw new Error("get trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    });
    const result = authorize(
      valid({ target: { candidate: "https://example.com/", resolvedAddresses: addressProxy } }),
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((block) => block.code)).toContain("target_invalid");

    const getProxy = new Proxy(["8.8.8.8"], {
      get: () => {
        throw new Error("get trap");
      },
    });
    const getResult = authorize(
      valid({ target: { candidate: "https://example.com/", resolvedAddresses: getProxy } }),
    );
    expect(getResult.allowed).toBe(false);
    expect(getResult.blocked.map((block) => block.code)).toContain("target_invalid");

    const accessorAddresses: unknown[] = ["8.8.8.8"];
    Object.defineProperty(accessorAddresses, "0", { get: () => "8.8.8.8" });
    const accessorResult = authorize(
      valid({
        target: { candidate: "https://example.com/", resolvedAddresses: accessorAddresses },
      }),
    );
    expect(accessorResult.allowed).toBe(false);
    expect(accessorResult.blocked.map((block) => block.code)).toContain("target_invalid");
  });

  it("caps caller limit facts to the validated playbook contract", () => {
    const result = authorize(
      valid({
        limits: {
          ...limits(),
          playbook: { ...limits().playbook, durationS: 999, ratePerMin: 999 },
        },
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.limits).toMatchObject({ durationS: 300, ratePerMin: 10 });
  });
});
