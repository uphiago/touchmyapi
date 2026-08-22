import { describe, expect, it } from "vitest";
import { authorize, type ActionRequest } from "../src/engine";
import { compileScope } from "../src/scope";

const scope = compileScope({ inclusions: ["example.com"], exclusions: [] });
const ipv6Scope = compileScope({
  inclusions: ["[2001:4860:4860::8888]"],
  exclusions: [],
});
const CONTEXT = {
  accountId: "11111111-1111-4111-8111-111111111111",
  assessmentId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  evaluatedAt: "2026-08-22T12:00:00.000Z",
  scopeFingerprint: `sha256:${"a".repeat(64)}`,
} as const;

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
  context: CONTEXT,
  action: "passive_external",
  targetCategory: "surface",
  target: { candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
  scope,
  entitlement: "free_unverified",
  limits: limits(),
  attestation: {
    version: "terms@1",
    accountId: CONTEXT.accountId,
    assessmentId: CONTEXT.assessmentId,
    userId: CONTEXT.userId,
    target: "https://example.com/",
    scopeFingerprint: CONTEXT.scopeFingerprint,
    playbookKey: "surface-public-posture",
    playbookVersion: "1.0.0",
    acceptedAt: "2026-08-22T11:59:00.000Z",
  },
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
    expect(result.target).toEqual({
      url: "https://example.com/",
      hostname: "example.com",
      port: 443,
      path: "/",
      protocol: "https:",
    });
    expect(result.resolvedAddresses).toEqual(["8.8.8.8"]);
    expect(result.scopeFingerprint).toBe(CONTEXT.scopeFingerprint);
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Object.isFrozen(result.resolvedAddresses)).toBe(true);
    expect(() => (result.resolvedAddresses as string[]).push("1.1.1.1")).toThrow();
  });

  it("allows active verified assessments only for plans with active rights", () => {
    const result = authorize(
      valid({
        action: "active_external",
        entitlement: "free_verified",
        verification: {
          method: "http_file",
          status: "verified",
          accountId: CONTEXT.accountId,
          assessmentId: CONTEXT.assessmentId,
          targetOrigin: "https://example.com",
          scopeFingerprint: CONTEXT.scopeFingerprint,
          challengeId: "44444444-4444-4444-8444-444444444444",
          verifiedAt: "2026-08-22T11:58:00.000Z",
          expiresAt: "2026-08-22T13:00:00.000Z",
        },
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
    expect(result.target).toBeNull();
    expect(result.resolvedAddresses).toEqual([]);
    expect(result.scopeFingerprint).toBeNull();
    expect(result.reason).toBe("assessment blocked by policy");
    expect(result.blocked.map((block) => block.code)).toEqual([
      "unknown_action",
      "unknown_target_category",
      "unknown_plan",
      "port_not_allowed",
      "forbidden_target",
      "target_category_mismatch",
      "attestation_required",
      "verification_method_not_allowed",
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

  it.each([
    ["missing context", { context: undefined }],
    ["bad account id", { context: { ...CONTEXT, accountId: "not-an-id" } }],
    ["bad evaluatedAt", { context: { ...CONTEXT, evaluatedAt: "2026-99-99T00:00:00Z" } }],
    ["bad fingerprint", { context: { ...CONTEXT, scopeFingerprint: "sha256:bad" } }],
  ])("requires strict server context facts (%s)", (_name, overrides) => {
    const result = authorize(valid(overrides));
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((block) => block.code)).toContain("invalid_context");
  });

  it.each([
    {
      target: {
        candidate: "https://example.com/",
        resolvedAddresses: ["8.8.8.8"],
        url: "https://other.example/",
      },
    },
    {
      target: { candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
      candidate: "https://other.example/",
    },
    {
      target: { candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
      candidateUrl: "https://other.example/",
    },
    {
      target: { candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
      resolvedAddresses: ["8.8.8.8"],
    },
    {
      scope: { compiled: scope, candidate: "https://example.com/", resolvedAddresses: ["8.8.8.8"] },
    },
  ])("rejects target and scope aliases or conflicting extras", (overrides) => {
    const result = authorize(valid(overrides));
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((block) => block.code)).toContain("target_invalid");
  });

  it("binds attestation to every server context fact and playbook", () => {
    const base = valid().attestation as Record<string, unknown>;
    const wrongValues: Record<string, unknown> = {
      accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      target: "https://other.example/",
      scopeFingerprint: `sha256:${"b".repeat(64)}`,
      playbookKey: "other-playbook",
      playbookVersion: "2.0.0",
    };
    for (const field of Object.keys(wrongValues)) {
      const result = authorize(valid({ attestation: { ...base, [field]: wrongValues[field] } }));
      expect(result.allowed).toBe(false);
      expect(result.blocked.map((block) => block.code)).toContain(
        field === "playbookKey" || field === "playbookVersion"
          ? "invalid_attestation"
          : "attestation_context_mismatch",
      );
    }
    expect(authorize(valid({ attestation: { ...base, version: "terms@2" } })).allowed).toBe(false);
    expect(
      authorize(valid({ attestation: { ...base, acceptedAt: "2026-08-22T12:01:00.000Z" } }))
        .allowed,
    ).toBe(false);
  });

  it("binds active verification and rejects replay, expiry, and DNS TXT", () => {
    const verification = {
      method: "http_file",
      status: "verified",
      accountId: CONTEXT.accountId,
      assessmentId: CONTEXT.assessmentId,
      targetOrigin: "https://example.com",
      scopeFingerprint: CONTEXT.scopeFingerprint,
      challengeId: "44444444-4444-4444-8444-444444444444",
      verifiedAt: "2026-08-22T11:58:00.000Z",
      expiresAt: "2026-08-22T13:00:00.000Z",
    };
    const wrongValues: Record<string, unknown> = {
      accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetOrigin: "https://other.example",
      scopeFingerprint: `sha256:${"b".repeat(64)}`,
    };
    for (const field of Object.keys(wrongValues)) {
      const result = authorize(
        valid({
          action: "active_external",
          entitlement: "pro",
          verification: { ...verification, [field]: wrongValues[field] },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.blocked.map((block) => block.code)).toContain("verification_context_mismatch");
    }
    expect(
      authorize(
        valid({
          action: "active_external",
          entitlement: "pro",
          verification: { ...verification, expiresAt: "2026-08-22T12:00:00.000Z" },
        }),
      ).blocked.map((block) => block.code),
    ).toContain("verification_expired");
    expect(
      authorize(
        valid({
          action: "active_external",
          entitlement: "pro",
          verification: { ...verification, verifiedAt: "2026-08-22T12:01:00.000Z" },
        }),
      ).blocked.map((block) => block.code),
    ).toContain("verification_not_verified");
    expect(
      authorize(
        valid({
          action: "active_external",
          entitlement: "pro",
          verification: { method: "dns_txt" },
        }),
      ).blocked.map((block) => block.code),
    ).toContain("verification_method_not_allowed");
  });

  it("canonicalizes public IPv6 target origins with brackets for passive and active facts", () => {
    const target = "https://[2001:4860:4860::8888]/";
    const attestation = {
      ...(valid().attestation as Record<string, unknown>),
      target,
    };
    const passive = authorize(
      valid({
        scope: ipv6Scope,
        target: { candidate: target, resolvedAddresses: ["2001:4860:4860::8888"] },
        attestation,
      }),
    );
    expect(passive.allowed).toBe(true);
    expect(passive.target?.url).toBe(target);

    const verification = {
      method: "http_file",
      status: "verified",
      accountId: CONTEXT.accountId,
      assessmentId: CONTEXT.assessmentId,
      targetOrigin: "https://[2001:4860:4860::8888]",
      scopeFingerprint: CONTEXT.scopeFingerprint,
      challengeId: "44444444-4444-4444-8444-444444444444",
      verifiedAt: "2026-08-22T11:58:00.000Z",
      expiresAt: "2026-08-22T13:00:00.000Z",
    };
    const active = authorize(
      valid({
        action: "active_external",
        entitlement: "pro",
        scope: ipv6Scope,
        target: { candidate: target, resolvedAddresses: ["2001:4860:4860::8888"] },
        attestation,
        verification,
      }),
    );
    expect(active.allowed).toBe(true);
    const mismatch = authorize(
      valid({
        action: "active_external",
        entitlement: "pro",
        scope: ipv6Scope,
        target: { candidate: target, resolvedAddresses: ["2001:4860:4860::8888"] },
        attestation,
        verification: { ...verification, targetOrigin: "https://2001:4860:4860::8888" },
      }),
    );
    expect(mismatch.allowed).toBe(false);
    expect(mismatch.blocked.map((block) => block.code)).toContain("verification_context_mismatch");
  });

  it("requires exact playbook stop/precondition sets and conservative action facts", () => {
    const current = playbook();
    expect(
      authorize(valid({ playbook: { ...current, stopSignals: ["scope_escape"] } })).allowed,
    ).toBe(false);
    expect(
      authorize(
        valid({
          playbook: {
            ...current,
            preconditions: [
              { kind: "http_verification_required", when: "active_external" },
              { kind: "future", when: "never" },
            ],
          },
        }),
      ).allowed,
    ).toBe(false);
    const missingMethod = structuredClone(current);
    delete (missingMethod.actions[2] as Record<string, unknown>).method;
    expect(authorize(valid({ playbook: missingMethod })).allowed).toBe(false);
    const dnsMethod = structuredClone(current);
    (dnsMethod.actions[0] as Record<string, unknown>).method = "GET";
    expect(authorize(valid({ playbook: dnsMethod })).allowed).toBe(false);
    const hugeRequests = structuredClone(current);
    (hugeRequests.actions[0] as Record<string, unknown>).limit = { requests: 11, durationS: 30 };
    expect(authorize(valid({ playbook: hugeRequests })).allowed).toBe(false);
  });
});
