import {
  passiveObservationSchema,
  type PassiveObservation,
  type RedactedObject,
} from "@touchmyapi/contracts";

const CATALOG_ACTIONS = [
  "dns.records",
  "tls.cert",
  "http.headers",
  "robots.txt",
  "sitemap.xml",
  "endpoint.minimal",
] as const;

type Severity = "info" | "low";

export type AnalyzedFinding = Readonly<{
  sourceKey: string;
  title: string;
  category: string;
  severity: Severity;
  endpoint: string | null;
  evidence: RedactedObject;
  reproduction: readonly string[];
  impact: string;
  remediation: string;
  conclusion: "fact" | "inference";
}>;

export type PassiveAnalysis = Readonly<{
  findings: readonly AnalyzedFinding[];
  limitations: readonly string[];
  untestedActions: readonly string[];
}>;

function booleanFact(data: RedactedObject, key: string): boolean | undefined {
  return typeof data[key] === "boolean" ? data[key] : undefined;
}

function numberFact(data: RedactedObject, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function endpointFact(data: RedactedObject): string | null {
  const value = data.endpoint;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  return value;
}

function finding(
  sourceKey: string,
  title: string,
  category: string,
  severity: Severity,
  endpoint: string | null,
  evidence: RedactedObject,
  impact: string,
  remediation: string,
  conclusion: "fact" | "inference" = "fact",
): AnalyzedFinding {
  return Object.freeze({
    sourceKey,
    title,
    category,
    severity,
    endpoint,
    evidence: Object.freeze({ ...evidence }),
    reproduction: Object.freeze([]),
    impact,
    remediation,
    conclusion,
  });
}

function analyzeObservation(observation: PassiveObservation): readonly AnalyzedFinding[] {
  const data = observation.data;
  const endpoint = endpointFact(data);
  const findings: AnalyzedFinding[] = [];

  if (observation.actionId === "http.headers" && observation.kind === "http_headers") {
    if (booleanFact(data, "contentSecurityPolicy") === false) {
      findings.push(
        finding(
          "http.headers:csp_missing",
          "Content Security Policy was not observed",
          "headers",
          "low",
          endpoint,
          { observedAt: observation.observedAt, contentSecurityPolicy: false },
          "Browser-side injection defenses have less depth when a content policy is absent.",
          "Deploy a restrictive Content-Security-Policy and validate it against application behavior.",
        ),
      );
    }
    if (booleanFact(data, "strictTransportSecurity") === false) {
      findings.push(
        finding(
          "http.headers:hsts_missing",
          "HTTP Strict Transport Security was not observed",
          "transport",
          "low",
          endpoint,
          { observedAt: observation.observedAt, strictTransportSecurity: false },
          "First visits can have weaker downgrade resistance without an HSTS policy.",
          "Enable Strict-Transport-Security after confirming HTTPS coverage for the intended hosts.",
        ),
      );
    }
  }

  if (observation.actionId === "tls.cert" && observation.kind === "tls_certificate") {
    if (booleanFact(data, "valid") === false) {
      findings.push(
        finding(
          "tls.cert:invalid",
          "The observed TLS certificate was not valid",
          "transport",
          "low",
          endpoint,
          { observedAt: observation.observedAt, valid: false },
          "Clients may reject or distrust the encrypted connection.",
          "Replace or repair the certificate chain and verify hostname and validity dates.",
        ),
      );
    }
    const daysRemaining = numberFact(data, "daysRemaining");
    if (daysRemaining !== undefined && daysRemaining >= 0 && daysRemaining < 30) {
      findings.push(
        finding(
          "tls.cert:expires_soon",
          "The observed TLS certificate expires soon",
          "transport",
          "low",
          endpoint,
          { observedAt: observation.observedAt, daysRemaining: Math.floor(daysRemaining) },
          "An unrenewed certificate can interrupt trusted HTTPS service.",
          "Renew the certificate and confirm automated renewal before expiration.",
        ),
      );
    }
  }

  if (observation.actionId === "dns.records" && observation.kind === "dns_records") {
    if (booleanFact(data, "hasCaa") === false) {
      findings.push(
        finding(
          "dns.records:caa_missing",
          "No CAA restriction was observed",
          "dns",
          "info",
          endpoint,
          { observedAt: observation.observedAt, hasCaa: false },
          "Certificate issuance is not restricted by a published CAA policy.",
          "Consider publishing CAA records for the certificate authorities used by the organization.",
          "inference",
        ),
      );
    }
  }

  return findings;
}

export function analyzePassiveObservations(input: readonly unknown[]): PassiveAnalysis {
  if (input.length > 32) throw new RangeError("passive observation limit exceeded");
  const observations = input.map((item) => passiveObservationSchema.parse(item));
  const observedActions = new Set(observations.map((item) => item.actionId));
  const bySourceKey = new Map<string, AnalyzedFinding>();
  for (const observation of observations) {
    for (const item of analyzeObservation(observation)) bySourceKey.set(item.sourceKey, item);
  }
  return Object.freeze({
    findings: Object.freeze(
      [...bySourceKey.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    ),
    limitations: Object.freeze([
      "Only the published passive public-posture actions were considered.",
      "No authenticated or state-changing behavior was tested.",
      "Absence of an observation is not evidence that a control is absent.",
    ]),
    untestedActions: Object.freeze(
      CATALOG_ACTIONS.filter((action) => !observedActions.has(action)),
    ),
  });
}
