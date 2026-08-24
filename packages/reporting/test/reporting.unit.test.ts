import { describe, expect, it } from "vitest";
import {
  generateReportObjects,
  renderExecutivePdf,
  renderTechnicalPdf,
  sanitizeReport,
  stableFindingId,
  writeJsonExport,
} from "../src";
import {
  MemoryPrivateReportStorage,
  reportObjectKey,
  S3CompatiblePrivateReportStorage,
} from "../src/storage";

const assessmentId = "123e4567-e89b-12d3-a456-426614174001";
const findingId = "123e4567-e89b-12d3-a456-426614174002";
const source = {
  schemaVersion: "report.json@1" as const,
  assessmentId,
  generatedAt: "2026-08-24T12:10:00.000Z",
  plan: "pro" as const,
  target: {
    hostname: "example.test",
    credentials: { token: "must-not-leak" },
    authorization: "Bearer must-not-leak",
  },
  scope: {
    inclusions: ["example.test/*"],
    exclusions: [],
    window: {
      start: "2026-08-24T12:00:00.000Z",
      end: "2026-08-24T12:05:00.000Z",
    },
  },
  playbook: { key: "surface-public-posture", version: "1.0.0" },
  methodology: ["Passive HTTP inspection"],
  limitations: ["Untested authenticated routes"],
  findings: [
    {
      id: findingId,
      title: "Missing security header",
      category: "http.headers",
      severity: "low",
      evidence: {
        observed: "https://example.test/check?token=must-not-leak",
        apiKey: "must-not-leak",
      },
      reproduction: ["Inspect response headers"],
      impact: "Transport downgrade risk",
      remediation: "Set the header at the edge",
    },
  ],
  credits: { consumed: 1, estimate: 2 },
};

describe("private reporting foundation", () => {
  it("sanitizes credentials and gates finding detail before JSON composition", () => {
    const sourceWithSecretScope = {
      ...source,
      scope: {
        ...source.scope,
        inclusions: ["example.test/*?token=must-not-leak"],
        exclusions: ["Bearer must-not-leak"],
      },
    };
    const aggregate = sanitizeReport(
      { ...sourceWithSecretScope, plan: "free_unverified" },
      "free_unverified",
    );
    expect(aggregate.findings).toEqual([]);
    const free = sanitizeReport(
      { ...sourceWithSecretScope, plan: "free_verified" },
      "free_verified",
    );
    expect(free.target).toEqual({ hostname: "example.test" });
    expect(free.scope.inclusions).toEqual(["example.test/*?token=[REDACTED]"]);
    expect(free.scope.exclusions).toEqual(["[REDACTED]"]);
    expect(free.findings[0]).toEqual({
      id: findingId,
      title: "Missing security header",
      category: "http.headers",
      severity: "low",
    });

    const paid = sanitizeReport(sourceWithSecretScope, "pro");
    expect(paid.target).toEqual({ hostname: "example.test" });
    expect(paid.scope.inclusions).toEqual(["example.test/*?token=[REDACTED]"]);
    expect(paid.scope.exclusions).toEqual(["[REDACTED]"]);
    expect(paid.findings[0]?.evidence).toEqual({
      observed: "https://example.test/check?token=[REDACTED]",
    });
    expect(JSON.stringify(paid)).not.toContain("must-not-leak");
  });

  it("writes canonical, schema-versioned JSON with no secret-bearing fields", () => {
    const report = sanitizeReport(source, "pro");
    const first = writeJsonExport(report);
    const second = writeJsonExport({ ...report, findings: [...report.findings] });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(new TextDecoder().decode(first)).toContain('"schemaVersion":"report.json@1"');
    expect(new TextDecoder().decode(first)).not.toContain("apiKey");
  });

  it("renders deterministic paginated technical and executive PDFs", async () => {
    const report = sanitizeReport(source, "pro");
    const technicalFirst = await renderTechnicalPdf(report);
    const technicalSecond = await renderTechnicalPdf(report);
    expect(Buffer.from(technicalFirst).equals(Buffer.from(technicalSecond))).toBe(true);
    expect(new TextDecoder().decode(technicalFirst.subarray(0, 8))).toBe("%PDF-1.3");
    expect(technicalFirst.byteLength).toBeGreaterThan(1_000);
    const executive = await renderExecutivePdf(report);
    expect(new TextDecoder().decode(executive.subarray(0, 8))).toBe("%PDF-1.3");
  });

  it("keeps report storage private and rejects unsafe object keys", async () => {
    const storage = new MemoryPrivateReportStorage();
    const key = reportObjectKey("123e4567-e89b-12d3-a456-426614174010", assessmentId, "json");
    await storage.put(key, new Uint8Array([1, 2, 3]), "application/json");
    expect(await storage.get(key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.createDownloadUrl(key, 60)).toMatch(/^memory:\/\//u);
    expect(() => reportObjectKey("../account", assessmentId, "json")).toThrow();
  });

  it("signs MinIO-compatible requests without placing the secret key in URLs", async () => {
    const requests: Request[] = [];
    const storage = new S3CompatiblePrivateReportStorage({
      endpoint: "http://minio.example.test:9000",
      bucket: "private-reports",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key-must-not-leak",
      createBucket: true,
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: requests.length === 1 ? 404 : 200 });
      }) as typeof fetch,
    });
    await storage.ensurePrivateBucket();
    await storage.put("reports/example/report", new Uint8Array([1]), "application/octet-stream");
    const url = await storage.createDownloadUrl("reports/example/report", 60);
    expect(url).toContain("X-Amz-Signature=");
    expect(url).not.toContain("secret-key-must-not-leak");
    expect(requests[0]?.method).toBe("HEAD");
    expect(requests[0]?.url).toContain("/private-reports/");
    expect(requests[1]?.method).toBe("PUT");
    expect(requests[2]?.url).toContain("/private-reports/reports/example/report");
    expect(requests[2]?.headers.get("authorization")).toContain("Credential=access-key/");
  });

  it("checks a production bucket without trying to create it", async () => {
    const methods: string[] = [];
    const storage = new S3CompatiblePrivateReportStorage({
      endpoint: "https://r2.example.test",
      bucket: "private-reports",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      fetch: (async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    await expect(storage.ensurePrivateBucket()).rejects.toThrow(
      "private storage bucket unavailable",
    );
    expect(methods).toEqual(["HEAD"]);
  });

  it("builds three deterministic paid objects and no free report artifacts", async () => {
    const paid = await generateReportObjects("123e4567-e89b-12d3-a456-426614174010", source, "pro");
    expect(paid.map((item) => item.kind)).toEqual(["json", "pdf_technical", "pdf_executive"]);
    expect(paid.every((item) => item.objectKey.startsWith("reports/"))).toBe(true);
    await expect(
      generateReportObjects("123e4567-e89b-12d3-a456-426614174010", source, "free_verified"),
    ).resolves.toEqual([]);
    expect(stableFindingId(assessmentId, "http.headers:hsts_missing")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
