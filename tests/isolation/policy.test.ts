import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScope, matchesScope } from "../../packages/policy/src/index";

const policyRoot = resolve(import.meta.dirname, "../../packages/policy/src");

describe("policy isolation", () => {
  it("contains no network, filesystem, process environment, or app imports", () => {
    const source = ["scope.ts", "engine.ts", "entitlement.ts", "limits.ts"]
      .map((file) => readFileSync(resolve(policyRoot, file), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|socket)\s*\(/i);
    expect(source).not.toMatch(/process\.env\b/i);
    expect(source).not.toMatch(/from "node:(?!crypto)/);
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
