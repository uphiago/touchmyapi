import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScope, matchesScope } from "../../packages/policy/src/index";

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
    expect(matchesScope(scope, "https://other.example.com/")).toBe(false);
    expect(matchesScope(scope, "https://public.example.com/")).toBe(true);
    expect(matchesScope(scope, "https://public.example.com/private/data")).toBe(false);
    expect(matchesScope(scope, 42 as never)).toBe(false);
  });
});
