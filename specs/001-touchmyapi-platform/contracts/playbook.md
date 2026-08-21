# Playbook Contract v1

Every playbook is a versioned JSON contract validated by `packages/playbooks` against zod schema. The policy engine reads playbooks as the *only* source of allowed actions/limits; the browser only renders the human-safe summary. Follows the sequence: scope → discovery → hypothesis → focused validation → negative control → evidence → report (spec §6.4).

## Schema (v1)

```jsonc
{
  "schemaVersion": "playbook.schema@1",
  "key": "surface-public-posture",
  "version": "1.0.0",
  "targetCategory": "surface",            // web | api | surface | genai | internal
  "active": true,
  "preconditions": [
    { "kind": "http_verification_required", "when": "active_external" }
  ],
  "actions": [
    {
      "id": "http.headers",
      "type": "http_probe",               // closed vocabulary
      "allowedTargets": "scope",          // only within declared scope
      "method": "GET",
      "limit": { "requests": 5, "durationS": 30 }
    }
    // e.g. dns.records, tls.cert, robots.txt, sitemap.xml, endpoint.minimal
    // Denied by default: auth, payloads, exploitation, brute force, fuzzing,
    // wide crawling, active validation (spec §3.1).
  ],
  "limits": {
    "maxDurationS": 300,
    "maxConcurrency": 1,
    "maxRatePerMin": 10,
    "egress": { "allow": ["scope_target"], "blockDefaults": true },
    "impactLevels": ["low"]
  },
  "stopSignals": [
    "scope_escape",
    "rate_exceeded",
    "unauthorized_endpoint",
    "duration_exceeded"
  ],
  "evidence": {
    "expected": ["http_headers_snapshot", "tls_cert_metadata"],
    "format": "manifest"
  },
  "severityPossible": ["info", "low"]
}
```

## Rules

- `actions[]` is a **closed list**; the runner may execute nothing absent from it (constitution IV).
- The policy engine reduces the request to actions that match scope + entitlement + plan limits. User-specified limits may not *exceed* playbook limits and are always capped by the playbook.
- Free plan (unverified) maps to a passive-only slice (`surface-public-posture` without active actions); free verified adds the restricted introductory playbook with findings masked.
- A new category, dangerous action, or invasive exploitation requires an explicit new playbook with its own policy + consent (spec §6.4).