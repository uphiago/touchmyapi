import { describe, expect, it } from "vitest";
import { reduceLimits, type LimitInput } from "../src/limits";

const authority = (overrides: Record<string, unknown> = {}) => ({
  durationS: 120,
  concurrency: 2,
  ratePerMin: 5,
  credits: 4,
  ...overrides,
});

const validInput = (): LimitInput => ({
  playbook: { ...authority(), egress: ["scope_target"] },
  entitlement: authority({ durationS: 60, concurrency: 1, ratePerMin: 2, credits: 2 }),
  account: authority({ durationS: 90, concurrency: 3, ratePerMin: 3, credits: 5 }),
  global: authority({ durationS: 300, concurrency: 5, ratePerMin: 10, credits: 10 }),
});

describe("non-escalating limits", () => {
  it("reduces all authoritative ceilings and preserves only playbook egress", () => {
    const result = reduceLimits(validInput());
    expect(result).toEqual({
      ok: true,
      value: {
        durationS: 60,
        concurrency: 1,
        ratePerMin: 2,
        credits: 2,
        egress: ["scope_target"],
      },
    });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each(["playbook", "entitlement", "account", "global"] as const)(
    "denies absent authoritative source %s",
    (source) => {
      const input = validInput() as unknown as Record<string, unknown>;
      delete input[source];
      expect(reduceLimits(input as LimitInput)).toEqual({
        ok: false,
        code: "missing_authoritative_limit",
      });
    },
  );

  it.each([
    ["durationS", undefined],
    ["concurrency", null],
    ["ratePerMin", 0],
    ["credits", -1],
    ["durationS", 1.5],
    ["credits", Number.NaN],
    ["ratePerMin", Number.POSITIVE_INFINITY],
    ["concurrency", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("denies invalid authoritative field %s", (field, value) => {
    const input = validInput();
    (input.account as Record<string, unknown>)[field] = value;
    expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_authoritative_limit" });
  });

  it.each(["playbook", "entitlement", "account", "global"] as const)(
    "denies an absent authoritative field in %s",
    (source) => {
      const input = validInput();
      delete (input[source] as Record<string, unknown>).credits;
      expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_authoritative_limit" });
    },
  );

  it.each(["browser", "model", "runner"])("does not accept %s as a limit authority", (source) => {
    const input = { ...validInput(), [source]: authority() };
    expect(reduceLimits(input as LimitInput)).toEqual({
      ok: false,
      code: "invalid_authoritative_limit",
    });
  });

  it.each(
    (["playbook", "entitlement", "account", "global"] as const).flatMap((source) =>
      (["durationS", "concurrency", "ratePerMin", "credits"] as const).map(
        (field) => [source, field] as const,
      ),
    ),
  )("rejects %s accessors for every ceiling field (%s)", (source, field) => {
    const input = validInput();
    let reads = 0;
    Object.defineProperty(input[source], field, {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 1 : Number.POSITIVE_INFINITY;
      },
    });
    expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_authoritative_limit" });
    expect(reads).toBe(0);
  });

  it("rejects an egress accessor without executing it", () => {
    const input = validInput();
    let reads = 0;
    Object.defineProperty(input.playbook, "egress", {
      configurable: true,
      get: () => {
        reads += 1;
        return ["scope_target"];
      },
    });
    expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_egress" });
    expect(reads).toBe(0);
  });

  it("rejects a root accessor without executing it", () => {
    const input = validInput() as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, "account", {
      configurable: true,
      get: () => {
        reads += 1;
        return authority({ durationS: Number.POSITIVE_INFINITY });
      },
    });
    expect(reduceLimits(input as LimitInput)).toEqual({
      ok: false,
      code: "invalid_authoritative_limit",
    });
    expect(reads).toBe(0);
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor"] as const)(
    "fails closed when an authority proxy %s trap throws",
    (trap) => {
      const target = validInput().account;
      const proxy = new Proxy(target, {
        [trap]: () => {
          throw new Error("trap");
        },
      });
      const input = { ...validInput(), account: proxy };
      expect(() => reduceLimits(input)).not.toThrow();
      expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_authoritative_limit" });
    },
  );

  it.each(["ownKeys", "getOwnPropertyDescriptor"] as const)(
    "fails closed when the root proxy %s trap throws",
    (trap) => {
      const proxy = new Proxy(validInput(), {
        [trap]: () => {
          throw new Error("trap");
        },
      });
      expect(() => reduceLimits(proxy as never)).not.toThrow();
      expect(reduceLimits(proxy as never)).toEqual({
        ok: false,
        code: "invalid_authoritative_limit",
      });
    },
  );

  it("does not execute a throwing root get trap", () => {
    const proxy = new Proxy(validInput(), {
      get: () => {
        throw new Error("get trap");
      },
    });
    expect(() => reduceLimits(proxy as never)).not.toThrow();
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor"] as const)(
    "fails closed when an egress proxy %s trap throws",
    (trap) => {
      const egress = new Proxy(["scope_target"], {
        [trap]: () => {
          throw new Error("trap");
        },
      });
      const input = validInput();
      (input.playbook as Record<string, unknown>).egress = egress;
      expect(() => reduceLimits(input)).not.toThrow();
      expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_egress" });
    },
  );

  it("does not execute a throwing egress get trap", () => {
    const egress = new Proxy(["scope_target"], {
      get: () => {
        throw new Error("get trap");
      },
    });
    const input = validInput();
    (input.playbook as Record<string, unknown>).egress = egress;
    expect(() => reduceLimits(input)).not.toThrow();
  });

  it("allows an omitted or partial requested ceiling", () => {
    expect(reduceLimits(validInput())).toMatchObject({ ok: true });
    expect(reduceLimits({ ...validInput(), requested: { durationS: 30 } })).toEqual({
      ok: true,
      value: { durationS: 30, concurrency: 1, ratePerMin: 2, credits: 2, egress: ["scope_target"] },
    });
  });

  it.each([
    { durationS: 10, concurrency: 1, ratePerMin: 1, credits: 1 },
    { durationS: 1000, concurrency: 1000, ratePerMin: 1000, credits: 1000 },
  ])("requested limits only reduce and never increase: %j", (requested) => {
    const result = reduceLimits({ ...validInput(), requested });
    expect(result).toEqual({
      ok: true,
      value: {
        durationS: Math.min(60, requested.durationS),
        concurrency: Math.min(1, requested.concurrency),
        ratePerMin: Math.min(2, requested.ratePerMin),
        credits: Math.min(2, requested.credits),
        egress: ["scope_target"],
      },
    });
  });

  it.each([
    { durationS: 0 },
    { concurrency: -1 },
    { ratePerMin: Number.NaN },
    { credits: Number.POSITIVE_INFINITY },
    { unknown: 1 },
  ])("denies invalid requested limits: %j", (requested) => {
    expect(reduceLimits({ ...validInput(), requested })).toEqual({
      ok: false,
      code: "invalid_requested_limit",
    });
  });

  it.each([Number.NaN, 1])(
    "rejects requested values inherited from a non-standard prototype (%j)",
    (durationS) => {
      const requested = Object.create({ durationS });
      expect(reduceLimits({ ...validInput(), requested })).toEqual({
        ok: false,
        code: "invalid_requested_limit",
      });
    },
  );

  it("rejects an invalid own non-enumerable requested value", () => {
    const requested: Record<string, unknown> = {};
    Object.defineProperty(requested, "durationS", { value: Number.NaN });
    expect(reduceLimits({ ...validInput(), requested })).toEqual({
      ok: false,
      code: "invalid_requested_limit",
    });
  });

  it("rejects symbol keys in requested limits", () => {
    const requested = { durationS: 10, [Symbol("unknown")]: 1 };
    expect(reduceLimits({ ...validInput(), requested })).toEqual({
      ok: false,
      code: "invalid_requested_limit",
    });
  });

  it.each([
    undefined,
    [],
    ["scope_target", "scope_target"],
    ["scope_target", "internet"],
    ["internet"],
  ])("denies malformed playbook egress %j", (egress) => {
    const input = validInput();
    (input.playbook as Record<string, unknown>).egress = egress;
    expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_egress" });
  });

  it("rejects unknown keys, freezes output, and never mutates input", () => {
    const input = validInput();
    const snapshot = structuredClone(input);
    (input.account as Record<string, unknown>).extra = 1;
    expect(reduceLimits(input)).toEqual({ ok: false, code: "invalid_authoritative_limit" });
    delete (input.account as Record<string, unknown>).extra;
    const result = reduceLimits(input);
    expect(input).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.egress)).toBe(true);
      expect(() => (result.value.egress as unknown as string[]).push("scope_target")).toThrow();
    }
  });

  it.each([null, [], "limits", 42, true])("fails closed for malformed root %j", (input) => {
    expect(() => reduceLimits(input as never)).not.toThrow();
    expect(reduceLimits(input as never)).toEqual({
      ok: false,
      code: "invalid_authoritative_limit",
    });
  });
});
