import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScope, matchesScope, normalizeExternalUrl } from "../../packages/policy/src/index";

const policyRoot = resolve(import.meta.dirname, "../../packages/policy/src");

describe("policy isolation", () => {
  it("contains no network, filesystem, process environment, or app imports", () => {
    const source = readFileSync(resolve(policyRoot, "scope.ts"), "utf8");
    expect(source).not.toMatch(
      /(?:^|[^\w])(?:dns|fs|tls|fetch|WebSocket|socket|process\.env)(?:[^\w]|$)/i,
    );
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("@touchmyapi/");
  });

  it("remains default-deny and applies exclusions before inclusions", () => {
    const scope = compileScope({
      inclusions: ["public.example.com"],
      exclusions: ["public.example.com/private"],
    });
    const outside = normalizeExternalUrl("https://other.example.com/");
    const included = normalizeExternalUrl("https://public.example.com/");
    const excluded = normalizeExternalUrl("https://public.example.com/private/data");
    if (!outside.ok || !included.ok || !excluded.ok)
      throw new Error("test target normalization failed");

    expect(matchesScope(scope, outside.value)).toBe(false);
    expect(matchesScope(scope, included.value)).toBe(true);
    expect(matchesScope(scope, excluded.value)).toBe(false);
  });
});
