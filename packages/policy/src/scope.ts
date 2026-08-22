/** Pure target-scope policy primitives. This module deliberately performs no I/O or name resolution. */

export type ScopeRule = {
  readonly host: string;
  readonly port: number | null;
  readonly pathPrefix: string;
  readonly wildcard: boolean;
};

export type CompiledScope = {
  readonly inclusions: readonly ScopeRule[];
  readonly exclusions: readonly ScopeRule[];
};

export type NormalizedTarget = {
  url: string;
  hostname: string;
  port: number;
  path: string;
  protocol: "http:" | "https:";
};

export type ScopeResult<T> = { ok: true; value: T } | { ok: false; code: string };

export type ScopeRuleInput =
  | string
  | {
      host: string;
      port?: number | null;
      pathPrefix?: string;
      wildcard?: boolean;
    };

export class ScopeValidationError extends Error {
  readonly code: string;

  constructor(code: string, message = `Invalid scope rule: ${code}`) {
    super(message);
    this.name = "ScopeValidationError";
    this.code = code;
  }
}

type IPv4 = [number, number, number, number];
type IPv6 = [number, number, number, number, number, number, number, number];

const DEFAULT_PORTS = { "http:": 80, "https:": 443 } as const;
const forbiddenNameSet = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function failure<T>(code: string): ScopeResult<T> {
  return { ok: false, code };
}

function hasControlCharacter(input: string): boolean {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function hasAmbiguousPathEncoding(input: string): boolean {
  return /%(?:2f|5c|2e|25)/i.test(input);
}

function rawUrlPath(input: string): string {
  const authorityStart = input.indexOf("://");
  if (authorityStart === -1) return "/";
  const pathStart = input.indexOf("/", authorityStart + 3);
  if (pathStart === -1) return "/";
  const queryStart = input.indexOf("?", pathStart);
  const fragmentStart = input.indexOf("#", pathStart);
  const endCandidates = [queryStart, fragmentStart].filter((index) => index !== -1);
  const pathEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : input.length;
  return input.slice(pathStart, pathEnd);
}

function parseIPv4(input: string): IPv4 | null {
  const pieces = input.split(".");
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return null;
  const values = pieces.map((piece) => Number(piece));
  if (values.some((value) => value > 255)) return null;
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
}

function parseIPv6(input: string): IPv6 | null {
  let value = input;
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) return null;
    value = value.slice(1, -1);
  }
  if (!value || value.includes("%")) return null;

  const dottedIndex = value.lastIndexOf(":");
  if (value.includes(".") && dottedIndex > -1) {
    const ipv4 = parseIPv4(value.slice(dottedIndex + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    value = `${value.slice(0, dottedIndex + 1)}${high.toString(16)}:${low.toString(16)}`;
  } else if (value.includes(".")) {
    return null;
  }

  const compression = value.indexOf("::");
  if (compression !== value.lastIndexOf("::")) return null;
  let parts: string[];
  if (compression !== -1) {
    const left = value.slice(0, compression);
    const right = value.slice(compression + 2);
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    if (leftParts.some((part) => !part) || rightParts.some((part) => !part)) return null;
    if (leftParts.length + rightParts.length >= 8) return null;
    parts = [
      ...leftParts,
      ...Array.from({ length: 8 - leftParts.length - rightParts.length }, () => "0"),
      ...rightParts,
    ];
  } else {
    parts = value.split(":");
    if (parts.length !== 8) return null;
  }
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  const values = parts.map((part) => Number.parseInt(part, 16));
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
    values[4] ?? 0,
    values[5] ?? 0,
    values[6] ?? 0,
    values[7] ?? 0,
  ];
}

function canonicalIPv4(value: IPv4): string {
  return value.join(".");
}

function canonicalIPv6(value: IPv6): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const zero = index < value.length && value[index] === 0;
    if (zero && runStart === -1) runStart = index;
    if (!zero && runStart !== -1) {
      const length = index - runStart;
      if (length > bestLength && length >= 2) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  const pieces: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index === bestStart) {
      pieces.push("");
      index += bestLength - 1;
      if (index === value.length - 1) pieces.push("");
    } else {
      pieces.push((value[index] ?? 0).toString(16));
    }
  }
  return pieces
    .join(":")
    .replace(/^:([^:])/, "::$1")
    .replace(/([^:]):$/, "$1::");
}

function isForbiddenIPv4(value: IPv4): boolean {
  const [a, b, c, d] = value;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isForbiddenIPv6(value: IPv6): boolean {
  const first = value[0] ?? 0;
  const second = value[1] ?? 0;
  const third = value[2] ?? 0;
  const fourth = value[3] ?? 0;
  const mapped =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    value[4] === 0 &&
    value[5] === 0xffff;
  if (mapped) {
    const mappedV4: IPv4 = [
      ((value[6] ?? 0) >> 8) & 255,
      (value[6] ?? 0) & 255,
      ((value[7] ?? 0) >> 8) & 255,
      (value[7] ?? 0) & 255,
    ];
    return isForbiddenIPv4(mappedV4);
  }
  const globalUnicast = first >= 0x2000 && first <= 0x3fff;
  if (!globalUnicast) return true;
  const unspecified = value.every((part) => part === 0);
  const loopback = unspecified && value[7] === 1;
  const ula = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const multicast = (first & 0xff00) === 0xff00;
  const documentation = first === 0x2001 && second === 0x0db8;
  const benchmark = first === 0x2001 && second === 0x0002;
  const sixToFour = first === 0x2002;
  const orchid = first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020);
  const reserved =
    first === 0x0000 ||
    (first === 0x2001 && second === 0x0000) ||
    (first === 0x3fff && (second & 0xf000) === 0);
  const discardOnly = first === 0x0100 && second === 0 && third === 0 && fourth === 0;
  return (
    sixToFour ||
    unspecified ||
    loopback ||
    ula ||
    linkLocal ||
    multicast ||
    documentation ||
    benchmark ||
    orchid ||
    reserved ||
    discardOnly
  );
}

function canonicalIp(input: string): { value: string; forbidden: boolean } | null {
  const ipv4 = parseIPv4(input);
  if (ipv4) return { value: canonicalIPv4(ipv4), forbidden: isForbiddenIPv4(ipv4) };
  const ipv6 = parseIPv6(input);
  if (ipv6) return { value: canonicalIPv6(ipv6), forbidden: isForbiddenIPv6(ipv6) };
  return null;
}

function forbiddenName(input: string): boolean {
  const value = input.toLowerCase().replace(/\.+$/, "");
  return (
    forbiddenNameSet.has(value) ||
    value.endsWith(".internal") ||
    value.endsWith(".local") ||
    value.endsWith(".localhost") ||
    value.endsWith(".test") ||
    value.endsWith(".invalid") ||
    value.endsWith(".example")
  );
}

export function isForbiddenAddress(input: string): boolean {
  if (typeof input !== "string") return true;
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!value || forbiddenName(value)) return true;
  const address = canonicalIp(value);
  return address?.forbidden ?? false;
}

function canonicalizeHost(input: string): string | null {
  if (input.trim() !== input) return null;
  const raw = input.trim();
  if (
    !raw ||
    /\s/.test(raw) ||
    hasControlCharacter(raw) ||
    raw.includes("/") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@") ||
    raw.includes("\\") ||
    raw.includes("*")
  )
    return null;
  const direct = canonicalIp(raw);
  if (direct) return direct.value;
  if (raw.includes(":")) return null;
  if (raw.endsWith("..")) return null;
  const withoutDot = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (!withoutDot || withoutDot.includes("..") || withoutDot.length > 253) return null;
  try {
    const parsed = new URL(`http://${withoutDot}/`);
    let hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
    if (!hostname || hostname.includes("..") || hostname.includes(":")) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function normalizeSurfaceHost(input: string): ScopeResult<{ hostname: string }> {
  if (typeof input !== "string") return failure("invalid_surface_host");
  const hostname = canonicalizeHost(input);
  if (!hostname) return failure("invalid_surface_host");
  if (isForbiddenAddress(hostname)) return failure("forbidden_surface_host");
  return { ok: true, value: { hostname } };
}

export function normalizeExternalUrl(input: string): ScopeResult<NormalizedTarget> {
  if (typeof input !== "string") return failure("invalid_url");
  if (hasAmbiguousPathEncoding(rawUrlPath(input))) {
    return failure("ambiguous_path_encoding");
  }
  if (
    !input ||
    input.trim() !== input ||
    /\s/.test(input) ||
    hasControlCharacter(input) ||
    /^https?:\/\/\//i.test(input) ||
    input.includes("#") ||
    input.includes("@") ||
    input.includes("\\")
  ) {
    return failure(
      input.includes("\\")
        ? "ambiguous_path_encoding"
        : input.includes("#")
          ? "fragment_not_allowed"
          : input.includes("@")
            ? "credentials_not_allowed"
            : "invalid_url",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return failure("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return failure("unsupported_protocol");
  if (parsed.username || parsed.password) return failure("credentials_not_allowed");
  if (!parsed.hostname) return failure("host_required");
  const hostname = canonicalizeHost(parsed.hostname);
  if (!hostname) return failure("invalid_url");
  if (isForbiddenAddress(hostname)) return failure("forbidden_target");
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return failure("invalid_url");
  const path = parsed.pathname || "/";
  if (hasAmbiguousPathEncoding(path)) return failure("ambiguous_path_encoding");
  const authority = hostname.includes(":") ? `[${hostname}]` : hostname;
  const portPart = port === DEFAULT_PORTS[parsed.protocol] ? "" : `:${port}`;
  return {
    ok: true,
    value: {
      url: `${parsed.protocol}//${authority}${portPart}${path}${parsed.search}`,
      hostname,
      port,
      path,
      protocol: parsed.protocol,
    },
  };
}

function normalizeRulePath(input: string): string | null {
  if (!input) return "/";
  if (hasAmbiguousPathEncoding(input) || input.includes("\\")) {
    throw new ScopeValidationError("ambiguous_path_encoding");
  }
  if (
    !input.startsWith("/") ||
    hasControlCharacter(input) ||
    input.includes("?") ||
    input.includes("#")
  )
    return null;
  const path = input.endsWith("/*") ? input.slice(0, -1) : input;
  try {
    const normalized = new URL(`http://scope.invalid${path}`).pathname;
    if (!normalized.startsWith("/")) return null;
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : "/";
  } catch {
    return null;
  }
}

function parseRulePort(input: string | undefined): number | null | undefined {
  if (input === undefined) return null;
  if (input === "") return undefined;
  if (!/^\d+$/.test(input)) return undefined;
  const port = Number(input);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function compileRule(input: ScopeRuleInput): ScopeRule {
  let hostInput: string;
  let pathInput: string;
  let portInput: number | null | undefined;
  let wildcard: boolean;

  if (typeof input === "string") {
    if (!input || /[?#@\s]/.test(input)) throw new ScopeValidationError("invalid_rule");
    const slash = input.indexOf("/");
    const authority = slash === -1 ? input : input.slice(0, slash);
    pathInput = slash === -1 ? "/" : input.slice(slash);
    wildcard = authority.startsWith("*.");
    let authorityHost = authority;
    let portText: string | undefined;
    if (authority.startsWith("[")) {
      const closing = authority.indexOf("]");
      if (closing === -1) throw new ScopeValidationError("invalid_rule");
      authorityHost = authority.slice(0, closing + 1);
      if (authority.length > closing + 1) {
        if (authority[closing + 1] !== ":") throw new ScopeValidationError("invalid_rule");
        portText = authority.slice(closing + 2);
      }
    } else {
      const colon = authority.lastIndexOf(":");
      if (colon !== -1) {
        if (authority.indexOf(":") !== colon) throw new ScopeValidationError("invalid_rule");
        authorityHost = authority.slice(0, colon);
        portText = authority.slice(colon + 1);
      }
    }
    hostInput = authorityHost;
    portInput = parseRulePort(portText);
    if (portInput === undefined) throw new ScopeValidationError("invalid_rule");
  } else {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.host !== "string" ||
      (input.pathPrefix !== undefined && typeof input.pathPrefix !== "string") ||
      (input.wildcard !== undefined && typeof input.wildcard !== "boolean") ||
      (input.port !== undefined && input.port !== null && typeof input.port !== "number")
    ) {
      throw new ScopeValidationError("invalid_rule");
    }
    hostInput = input.host;
    pathInput = input.pathPrefix ?? "/";
    portInput = input.port;
    wildcard = input.wildcard ?? input.host.startsWith("*.");
    if (
      portInput !== null &&
      portInput !== undefined &&
      (!Number.isInteger(portInput) || portInput < 1 || portInput > 65535)
    ) {
      throw new ScopeValidationError("invalid_rule");
    }
  }

  if (wildcard) {
    if (!hostInput.startsWith("*.")) throw new ScopeValidationError("invalid_wildcard");
    hostInput = hostInput.slice(2);
    if (!hostInput || hostInput.startsWith(".") || hostInput.includes("..")) {
      throw new ScopeValidationError("invalid_wildcard");
    }
  } else if (hostInput.startsWith("*")) {
    throw new ScopeValidationError("invalid_wildcard");
  }
  const host = canonicalizeHost(hostInput);
  if (!host || isForbiddenAddress(host)) throw new ScopeValidationError("forbidden_scope_rule");
  if (wildcard && (canonicalIp(host) || host.split(".").length < 2))
    throw new ScopeValidationError("invalid_wildcard");
  const pathPrefix = normalizeRulePath(pathInput);
  if (!pathPrefix) throw new ScopeValidationError("invalid_rule");
  return { host, port: portInput ?? null, pathPrefix, wildcard };
}

export function compileScope(input: {
  inclusions: readonly ScopeRuleInput[];
  exclusions: readonly ScopeRuleInput[];
}): CompiledScope {
  if (!input || !Array.isArray(input.inclusions) || !Array.isArray(input.exclusions)) {
    throw new ScopeValidationError("invalid_scope");
  }
  const inclusions = input.inclusions.map(compileRule).map((rule) => Object.freeze(rule));
  const exclusions = input.exclusions.map(compileRule).map((rule) => Object.freeze(rule));
  return Object.freeze({
    inclusions: Object.freeze(inclusions),
    exclusions: Object.freeze(exclusions),
  });
}

function pathMatches(prefix: string, path: string): boolean {
  if (prefix === "/") return path.startsWith("/");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function ruleMatches(rule: ScopeRule, candidate: NormalizedTarget): boolean {
  const hostname = candidate.hostname.toLowerCase().replace(/\.+$/, "");
  const hostMatches = rule.wildcard
    ? hostname.endsWith(`.${rule.host}`) &&
      hostname !== rule.host &&
      !hostname.slice(0, -rule.host.length - 1).includes(".")
    : hostname === rule.host;
  return (
    hostMatches &&
    (rule.port === null || rule.port === candidate.port) &&
    pathMatches(rule.pathPrefix, candidate.path)
  );
}

export function matchesScope(scope: CompiledScope, candidate: string): boolean;
export function matchesScope(scope: CompiledScope, candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  const normalized = normalizeExternalUrl(candidate);
  if (!normalized.ok) return false;
  const target = normalized.value;
  if (scope.exclusions.some((rule) => ruleMatches(rule, target))) return false;
  return scope.inclusions.some((rule) => ruleMatches(rule, target));
}

export function validateResolvedAddresses(
  hostname: string,
  addresses: readonly string[],
): ScopeResult<readonly string[]> {
  if (typeof hostname !== "string" || !Array.isArray(addresses)) {
    return failure("invalid_resolved_input");
  }
  const normalizedHostname = canonicalizeHost(hostname);
  if (!normalizedHostname) return failure("invalid_hostname");
  const hostIp = canonicalIp(normalizedHostname);
  if (hostIp)
    return hostIp.forbidden
      ? failure("forbidden_resolved_address")
      : { ok: true, value: [hostIp.value] };
  if (isForbiddenAddress(normalizedHostname)) return failure("forbidden_resolved_address");
  if (addresses.length === 0) return failure("resolved_addresses_required");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    if (typeof address !== "string") return failure("invalid_resolved_address");
    const parsed = canonicalIp(address.trim());
    if (!parsed) return failure("invalid_resolved_address");
    if (parsed.forbidden) return failure("forbidden_resolved_address");
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      normalized.push(parsed.value);
    }
  }
  return { ok: true, value: normalized };
}
