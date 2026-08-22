import { describe, expect, it } from "vitest";
import {
  ScopeValidationError,
  compileScope,
  isForbiddenAddress,
  matchesScope,
  normalizeExternalUrl,
  normalizeSurfaceHost,
  validateResolvedAddresses,
} from "../src/index";

const target = (input: string) => {
  const result = normalizeExternalUrl(input);
  if (!result.ok) throw new Error(result.code);
  return result.value;
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
    ["http://127.0.0.1", "forbidden_target"],
    ["http://metadata.google.internal", "forbidden_target"],
  ])("rejects unsafe or unsupported input %s", (input, code) => {
    const result = normalizeExternalUrl(input);
    expect(result).toEqual({ ok: false, code });
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
    "::ffff:192.168.1.1",
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "api.local",
  ])("blocks %s", (input) => expect(isForbiddenAddress(input)).toBe(true));

  it.each(["8.8.8.8", "2001:4860:4860::8888", "api.example.com"])(
    "allows a public address or hostname %s",
    (input) => expect(isForbiddenAddress(input)).toBe(false),
  );
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
    expect(matchesScope(scope, target("https://private.api.example.com/v1/private/x"))).toBe(false);
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

  it("is default-deny and gives exclusions precedence", () => {
    const scope = compileScope({ inclusions: ["example.com"], exclusions: ["example.com/admin"] });
    expect(matchesScope(scope, target("https://other.example.com/"))).toBe(false);
    expect(matchesScope(scope, target("https://example.com/"))).toBe(true);
    expect(matchesScope(scope, target("https://example.com/admin"))).toBe(false);
  });
});
