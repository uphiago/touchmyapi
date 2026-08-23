import { playbookSchema, type Playbook } from "@touchmyapi/contracts";
import { surfacePublicPosture } from "./surface-public-posture";

const passiveActionShape = new Map([
  ["dns.records", { type: "dns_lookup", requests: 1, durationS: 30, method: undefined }],
  ["tls.cert", { type: "tls_probe", requests: 1, durationS: 30, method: undefined }],
  ["http.headers", { type: "http_probe", requests: 5, durationS: 30, method: "GET" }],
  ["robots.txt", { type: "robots_fetch", requests: 1, durationS: 30, method: "GET" }],
  ["sitemap.xml", { type: "sitemap_fetch", requests: 1, durationS: 30, method: "GET" }],
  ["endpoint.minimal", { type: "endpoint_probe", requests: 2, durationS: 60, method: "GET" }],
] as const);

function assertCanonicalPassive(playbook: Playbook): void {
  if (
    playbook.schemaVersion !== "playbook.schema@1" ||
    playbook.key !== "surface-public-posture" ||
    playbook.version !== "1.0.0" ||
    playbook.targetCategory !== "surface" ||
    !playbook.active
  ) {
    throw new Error("invalid passive playbook");
  }

  const seen = new Set<string>();
  for (const action of playbook.actions) {
    const expected = passiveActionShape.get(action.id);
    if (!expected || seen.has(action.id)) throw new Error("invalid passive playbook");
    seen.add(action.id);
    if (
      action.type !== expected.type ||
      action.allowedTargets !== "scope" ||
      action.method !== expected.method ||
      action.limit.requests !== expected.requests ||
      action.limit.durationS !== expected.durationS
    ) {
      throw new Error("invalid passive playbook");
    }
  }
  if (seen.size !== passiveActionShape.size) throw new Error("invalid passive playbook");

  if (
    JSON.stringify(playbook.preconditions) !== JSON.stringify(surfacePublicPosture.preconditions)
  ) {
    throw new Error("invalid passive playbook");
  }
  if (JSON.stringify(playbook.limits) !== JSON.stringify(surfacePublicPosture.limits)) {
    throw new Error("invalid passive playbook");
  }
  if (JSON.stringify(playbook.stopSignals) !== JSON.stringify(surfacePublicPosture.stopSignals)) {
    throw new Error("invalid passive playbook");
  }
  if (JSON.stringify(playbook.evidence) !== JSON.stringify(surfacePublicPosture.evidence)) {
    throw new Error("invalid passive playbook");
  }
  if (
    JSON.stringify(playbook.severityPossible) !==
    JSON.stringify(surfacePublicPosture.severityPossible)
  ) {
    throw new Error("invalid passive playbook");
  }
}

/** Return a detached, schema-validated passive catalog with no execution behavior. */
export function slicePassive(input: Playbook): Playbook {
  const parsed = playbookSchema.parse(input);
  assertCanonicalPassive(parsed);
  return {
    ...parsed,
    preconditions: parsed.preconditions.map((precondition) => ({ ...precondition })),
    actions: parsed.actions.map((action) => ({ ...action, limit: { ...action.limit } })),
    limits: {
      ...parsed.limits,
      egress: { ...parsed.limits.egress, allow: [...parsed.limits.egress.allow] },
      impactLevels: [...parsed.limits.impactLevels],
    },
    stopSignals: [...parsed.stopSignals],
    evidence: { ...parsed.evidence, expected: [...parsed.evidence.expected] },
    severityPossible: [...parsed.severityPossible],
  };
}

export { playbookSchema, surfacePublicPosture };
export type { Playbook };
