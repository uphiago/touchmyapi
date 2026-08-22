import { describe, expect, it } from "vitest";
import {
  ScopeValidationError,
  type ScopeRule,
  compileScope,
  isForbiddenAddress,
  matchesScope,
  normalizeExternalUrl,
  normalizeSurfaceHost,
  validateResolvedAddresses,
} from "../src/index";

const target = (input: string) => {
  return input;
};

describe("normalizeExternalUrl", () => {
  it("canonicalizes case, IDN, trailing dot, default port, path and query", () => {
    expect(normalizeExternalUrl("HTTPS://MÜNICH.Example.COM.:443/a/../admin?q=1")).toEqual({
      ok: true,
      value: {
        url: "https://xn--mnich-kva.example.com/admin?q=1",
        hostname: "xn--mnich-kva.example.com",
        port: 443,
        path: "/admin",
        protocol: "https:",
      },
    });
  });

  it.each([
    ["ftp://example.com", "unsupported_protocol"],
    ["https://user:pass@example.com", "credentials_not_allowed"],
    ["https://example.com/#fragment", "fragment_not_allowed"],
    ["https:///missing-host", "invalid_url"],
    ["https://example.com:65536", "invalid_url"],
    ["https://example.com/admin/%2f..%2fsecret", "ambiguous_path_encoding"],
    ["https://example.com/admin/%5c..%5csecret", "ambiguous_path_encoding"],
    ["https://example.com/admin/%252fsecret", "ambiguous_path_encoding"],
    ["https://example.com/admin/%2e%2e/secret", "ambiguous_path_encoding"],
    ["https://example.com/admin\\..\\secret", "ambiguous_path_encoding"],
    ["http://127.0.0.1", "forbidden_target"],
    ["http://metadata.google.internal", "forbidden_target"],
  ])("rejects unsafe or unsupported input %s", (input, code) => {
    const result = normalizeExternalUrl(input);
    expect(result).toEqual({ ok: false, code });
  });

  it("preserves safe percent-encoded UTF-8 and spaces in the path", () => {
    expect(normalizeExternalUrl("https://example.com/admin/%C3%A9%20report")).toMatchObject({
      ok: true,
      value: { path: "/admin/%C3%A9%20report" },
    });
  });
});

describe("normalizeSurfaceHost", () => {
  it("accepts only a host and canonicalizes IDN and trailing dot", () => {
    expect(normalizeSurfaceHost("MÜNICH.Example.COM.")).toEqual({
      ok: true,
      value: { hostname: "xn--mnich-kva.example.com" },
    });
  });

  it.each([
    "https://example.com",
    "example.com:443",
    "example.com/path",
    "example.com?x=1",
    "example.com#x",
  ])("rejects non-host syntax %s", (input) =>
    expect(normalizeSurfaceHost(input)).toEqual({ ok: false, code: "invalid_surface_host" }),
  );

  it.each(["localhost", "foo.local", "service.internal", "metadata", "instance-data"])(
    "rejects internal or metadata host %s",
    (input) =>
      expect(normalizeSurfaceHost(input)).toEqual({ ok: false, code: "forbidden_surface_host" }),
  );

  it.each([null, 42, {}, []])("fails closed for malformed runtime host %j", (input) => {
    expect(() => normalizeSurfaceHost(input as never)).not.toThrow();
    expect(normalizeSurfaceHost(input as never)).toEqual({
      ok: false,
      code: "invalid_surface_host",
    });
  });
});

describe("forbidden addresses", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.10.20",
    "100.64.0.1",
    "224.0.0.1",
    "192.0.2.1",
    "198.51.100.7",
    "198.18.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "3fff::1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    "fec0::1",
    "4000::1",
    "::ffff:192.168.1.1",
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "api.local",
  ])("blocks %s", (input) => expect(isForbiddenAddress(input)).toBe(true));

  it.each(["8.8.8.8", "2001:4860:4860::8888", "api.example.com"])(
    "allows a public address or hostname %s",
    (input) => expect(isForbiddenAddress(input)).toBe(false),
  );

  it.each([null, 42, {}, []])("fails closed for runtime non-string input %j", (input) => {
    expect(() => isForbiddenAddress(input as never)).not.toThrow();
    expect(isForbiddenAddress(input as never)).toBe(true);
  });
});

describe("validateResolvedAddresses", () => {
  it("requires resolution facts for a DNS hostname and normalizes/deduplicates them", () => {
    expect(
      validateResolvedAddresses("api.example.com", ["8.8.8.8", "2001:4860:4860::8888", "8.8.8.8"]),
    ).toEqual({
      ok: true,
      value: ["8.8.8.8", "2001:4860:4860::8888"],
    });
    expect(validateResolvedAddresses("api.example.com", [])).toEqual({
      ok: false,
      code: "resolved_addresses_required",
    });
  });

  it("validates an IP hostname without trusting caller-provided alternatives", () => {
    expect(validateResolvedAddresses("8.8.8.8", ["10.0.0.1"])).toEqual({
      ok: true,
      value: ["8.8.8.8"],
    });
    expect(validateResolvedAddresses("::ffff:192.168.1.1", [])).toEqual({
      ok: false,
      code: "forbidden_resolved_address",
    });
  });

  it.each([
    [["10.0.0.1"], "forbidden_resolved_address"],
    [["fe80::1"], "forbidden_resolved_address"],
    [["not-an-address"], "invalid_resolved_address"],
  ])("fails closed for resolved addresses %j", (addresses, code) => {
    expect(validateResolvedAddresses("api.example.com", addresses)).toEqual({ ok: false, code });
  });

  it.each([
    [null, ["8.8.8.8"]],
    ["api.example.com", null],
    ["api.example.com", ["8.8.8.8", 42]],
  ])("fails closed for malformed runtime input %j", (hostname, addresses) => {
    expect(() => validateResolvedAddresses(hostname as never, addresses as never)).not.toThrow();
    expect(validateResolvedAddresses(hostname as never, addresses as never).ok).toBe(false);
  });
});

describe("compiled scopes", () => {
  it("accepts exact and left-most wildcard rules with explicit path-boundary semantics", () => {
    const scope = compileScope({
      inclusions: ["example.com/admin", "*.api.example.com/v1"],
      exclusions: ["private.api.example.com/v1/private"],
    });

    expect(scope.inclusions).toEqual([
      { host: "example.com", port: null, pathPrefix: "/admin", wildcard: false },
      { host: "api.example.com", port: null, pathPrefix: "/v1", wildcard: true },
    ]);
    expect(matchesScope(scope, target("https://example.com/admin"))).toBe(true);
    expect(matchesScope(scope, target("https://example.com/admin/users"))).toBe(true);
    expect(matchesScope(scope, target("https://example.com/administrator"))).toBe(false);
    expect(matchesScope(scope, target("https://foo.api.example.com/v1/check"))).toBe(true);
    expect(matchesScope(scope, target("https://api.example.com/v1/check"))).toBe(false);
    expect(matchesScope(scope, target("https://a.foo.api.example.com/v1/check"))).toBe(false);
    expect(matchesScope(scope, target("https://private.api.example.com/v1/private/x"))).toBe(false);
  });

  it("accepts a URL string candidate and fails closed on malformed candidates", () => {
    const scope = compileScope({ inclusions: ["example.com"], exclusions: [] });
    expect(matchesScope(scope, "https://example.com/")).toBe(true);
    expect(matchesScope(scope, "https://127.0.0.1/")).toBe(false);
    expect(() => matchesScope(scope, "not a URL")).not.toThrow();
    expect(matchesScope(scope, "not a URL")).toBe(false);
  });

  it("matches explicit ports and treats an omitted port as unconstrained", () => {
    const scope = compileScope({ inclusions: ["example.com:8443/"], exclusions: [] });
    expect(matchesScope(scope, target("https://example.com:8443/"))).toBe(true);
    expect(matchesScope(scope, target("https://example.com/"))).toBe(false);
    expect(
      matchesScope(
        compileScope({ inclusions: ["example.com"], exclusions: [] }),
        target("http://example.com:8080"),
      ),
    ).toBe(true);
  });

  it.each([
    "*",
    "*.com",
    "foo.*.example.com",
    "*..example.com",
    "*example.com",
    "127.0.0.1",
    "example.com:",
    "example.com:0",
    "example.com:65536",
  ])("rejects broad, malformed, or forbidden scope rule %s", (rule) => {
    expect(() => compileScope({ inclusions: [rule], exclusions: [] })).toThrow(
      ScopeValidationError,
    );
  });

  it.each([
    "example.com/admin/%2f..%2fsecret",
    "example.com/admin/%5csecret",
    "example.com/admin/%252fsecret",
    "example.com/admin/%2e%2e/secret",
    "example.com/admin\\secret",
  ])("rejects ambiguous encoded scope path %s", (rule) => {
    expect(() => compileScope({ inclusions: [rule], exclusions: [] })).toThrowError(
      expect.objectContaining({ code: "ambiguous_path_encoding" }),
    );
  });

  it.each([
    null,
    { host: 42 },
    { host: "example.com", pathPrefix: 42 },
    { host: "example.com", wildcard: "yes" },
    { host: "example.com", port: "443" },
  ])("rejects malformed runtime scope rule %j without TypeError", (rule) => {
    expect(() => compileScope({ inclusions: [rule as never], exclusions: [] })).not.toThrow(
      TypeError,
    );
    expect(() => compileScope({ inclusions: [rule as never], exclusions: [] })).toThrow(
      ScopeValidationError,
    );
  });

  it("deep-freezes compiled scope data", () => {
    const scope = compileScope({ inclusions: ["example.com/admin"], exclusions: [] });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.inclusions)).toBe(true);
    expect(Object.isFrozen(scope.inclusions[0])).toBe(true);
    expect(Object.isFrozen(scope.exclusions)).toBe(true);
    expect(() => {
      (scope.inclusions as ScopeRule[])[0] = {
        host: "other.example.com",
        port: null,
        pathPrefix: "/",
        wildcard: false,
      };
    }).toThrow();
    expect(matchesScope(scope, "https://example.com/admin")).toBe(true);
  });

  it("fails closed for null, malformed, forged, or adulterated compiled scopes", () => {
    const valid = compileScope({
      inclusions: ["example.com"],
      exclusions: ["example.com/private"],
    });
    const invalidScopes: unknown[] = [
      null,
      undefined,
      {},
      [],
      42,
      { inclusions: valid.inclusions, exclusions: valid.exclusions },
      { ...valid, inclusions: [...valid.inclusions] },
      {
        inclusions: [{ ...valid.inclusions[0] }],
        exclusions: valid.exclusions,
      },
      Object.freeze({ inclusions: [], exclusions: [] }),
    ];

    for (const invalid of invalidScopes) {
      expect(() => matchesScope(invalid as never, "https://example.com/")).not.toThrow();
      expect(matchesScope(invalid as never, "https://example.com/")).toBe(false);
    }
    expect(matchesScope(valid, "https://example.com/")).toBe(true);
  });

  it("reports an invalid wildcard code for an empty label", () => {
    expect(() => compileScope({ inclusions: ["*..example.com"], exclusions: [] })).toThrowError(
      expect.objectContaining({ code: "invalid_wildcard" }),
    );
  });

  it("is default-deny and gives exclusions precedence", () => {
    const scope = compileScope({ inclusions: ["example.com"], exclusions: ["example.com/admin"] });
    expect(matchesScope(scope, target("https://other.example.com/"))).toBe(false);
    expect(matchesScope(scope, target("https://example.com/"))).toBe(true);
    expect(matchesScope(scope, target("https://example.com/admin"))).toBe(false);
  });
});
