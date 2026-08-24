import { createHash, createHmac } from "node:crypto";

export type ReportObjectKind = "json" | "pdf_technical" | "pdf_executive";

export type PrivateReportStorage = Readonly<{
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_KEY = /^[A-Za-z0-9/_-]+$/u;
const SAFE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/u;

function validateKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    key.includes("..") ||
    !SAFE_KEY.test(key)
  ) {
    throw new TypeError("invalid report object key");
  }
  return key;
}

export function reportObjectKey(
  accountId: string,
  assessmentId: string,
  kind: ReportObjectKind,
): string {
  if (!UUID.test(accountId) || !UUID.test(assessmentId))
    throw new TypeError("invalid report identity");
  if (!Object.hasOwn({ json: true, pdf_technical: true, pdf_executive: true }, kind)) {
    throw new TypeError("invalid report kind");
  }
  return validateKey(`reports/${accountId}/${assessmentId}/${kind}`);
}

export class MemoryPrivateReportStorage implements PrivateReportStorage {
  readonly #objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    validateKey(key);
    if (!contentType || body.byteLength > 50 * 1024 * 1024)
      throw new TypeError("invalid report object");
    this.#objects.set(key, { body: new Uint8Array(body), contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.#objects.get(validateKey(key));
    if (!value) throw new Error("report object unavailable");
    return new Uint8Array(value.body);
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(validateKey(key));
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    validateKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
      throw new RangeError("invalid report URL expiry");
    }
    if (!this.#objects.has(key)) throw new Error("report object unavailable");
    return `memory://${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }
}

export type S3CompatibleStorageConfig = Readonly<{
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  createBucket?: boolean;
  fetch?: typeof fetch;
}>;

function hmac(key: Uint8Array | string, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function encodedPath(endpoint: URL, bucket: string, key: string): string {
  const prefix = endpoint.pathname.replace(/\/$/u, "");
  return `${prefix}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Minimal S3-compatible adapter for private MinIO/S3 buckets. Secret keys never enter URLs. */
export class S3CompatiblePrivateReportStorage implements PrivateReportStorage {
  readonly #endpoint: URL;
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #createBucket: boolean;
  readonly #fetch: typeof fetch;

  constructor(config: S3CompatibleStorageConfig) {
    this.#endpoint = new URL(config.endpoint);
    if (
      !/^https?:$/u.test(this.#endpoint.protocol) ||
      !SAFE_BUCKET.test(config.bucket) ||
      !config.accessKeyId ||
      !config.secretAccessKey ||
      this.#endpoint.username ||
      this.#endpoint.password ||
      this.#endpoint.search ||
      this.#endpoint.hash
    ) {
      throw new TypeError("invalid private storage configuration");
    }
    this.#bucket = config.bucket;
    this.#region = config.region ?? "us-east-1";
    this.#accessKeyId = config.accessKeyId;
    this.#secretAccessKey = config.secretAccessKey;
    this.#createBucket = config.createBucket === true;
    this.#fetch = config.fetch ?? fetch;
  }

  async ensurePrivateBucket(): Promise<void> {
    const now = new Date();
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const response = await this.#fetch(this.objectUrl(""), {
      method: "HEAD",
      headers: this.signedHeaders(
        "HEAD",
        "",
        now,
        { "x-amz-content-sha256": payloadHash, "x-amz-date": this.amzDate(now) },
        payloadHash,
      ),
    });
    if (response.ok) return;
    if (!this.#createBucket) throw new Error("private storage bucket unavailable");
    const createResponse = await this.#fetch(this.objectUrl(""), {
      method: "PUT",
      headers: this.signedHeaders(
        "PUT",
        "",
        now,
        { "x-amz-content-sha256": payloadHash, "x-amz-date": this.amzDate(now) },
        payloadHash,
      ),
    });
    if (!createResponse.ok && createResponse.status !== 409) {
      throw new Error("private storage bucket unavailable");
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    validateKey(key);
    if (!contentType || body.byteLength > 50 * 1024 * 1024)
      throw new TypeError("invalid report object");
    const now = new Date();
    const payloadHash = hex(createHash("sha256").update(body).digest());
    const headers = {
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": this.amzDate(now),
    };
    const response = await this.#fetch(this.objectUrl(key), {
      method: "PUT",
      headers: this.signedHeaders("PUT", key, now, headers, payloadHash),
      body: Buffer.from(body),
    });
    if (!response.ok) throw new Error("private storage request failed");
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    const now = new Date();
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const response = await this.#fetch(this.objectUrl(key), {
      method: "DELETE",
      headers: this.signedHeaders(
        "DELETE",
        key,
        now,
        { "x-amz-content-sha256": payloadHash, "x-amz-date": this.amzDate(now) },
        payloadHash,
      ),
    });
    if (!response.ok && response.status !== 404) throw new Error("private storage delete failed");
  }

  async get(key: string): Promise<Uint8Array> {
    validateKey(key);
    const now = new Date();
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const response = await this.#fetch(this.objectUrl(key), {
      headers: this.signedHeaders(
        "GET",
        key,
        now,
        { "x-amz-content-sha256": payloadHash, "x-amz-date": this.amzDate(now) },
        payloadHash,
      ),
    });
    if (!response.ok) throw new Error("private storage request failed");
    return new Uint8Array(await response.arrayBuffer());
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    validateKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800)
      throw new RangeError("invalid report URL expiry");
    const now = new Date();
    const date = this.amzDate(now);
    const credential = `${this.#accessKeyId}/${this.shortDate(now)}/${this.#region}/s3/aws4_request`;
    const url = new URL(this.objectUrl(key));
    url.search = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": date,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": "host",
    }).toString();
    const canonical = `GET\n${encodedPath(this.#endpoint, this.#bucket, key)}\n${[
      ...url.searchParams,
    ]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    url.searchParams.set("X-Amz-Signature", hex(this.sign(now, canonical)));
    return url.toString();
  }

  private objectUrl(key: string): string {
    const url = new URL(this.#endpoint);
    url.pathname = encodedPath(this.#endpoint, this.#bucket, key);
    return url.toString();
  }

  private amzDate(date: Date): string {
    return date
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}Z$/u, "Z");
  }
  private shortDate(date: Date): string {
    return this.amzDate(date).slice(0, 8);
  }

  private signedHeaders(
    method: string,
    key: string,
    date: Date,
    headers: Record<string, string>,
    payloadHash: string,
  ): Record<string, string> {
    const all = { host: this.#endpoint.host, ...headers };
    const canonicalHeaders = Object.entries(all)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}:${value.trim()}\n`)
      .join("");
    const signed = Object.keys(all).sort().join(";");
    const canonical = `${method}\n${encodedPath(this.#endpoint, this.#bucket, key)}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`;
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${this.shortDate(date)}/${this.#region}/s3/aws4_request, SignedHeaders=${signed}, Signature=${hex(this.sign(date, canonical))}`;
    return { ...headers, host: this.#endpoint.host, authorization };
  }

  private sign(date: Date, canonicalRequest: string): Uint8Array {
    const scope = `${this.shortDate(date)}/${this.#region}/s3/aws4_request`;
    const hash = hex(createHash("sha256").update(canonicalRequest).digest());
    const stringToSign = `AWS4-HMAC-SHA256\n${this.amzDate(date)}\n${scope}\n${hash}`;
    const dateKey = hmac(`AWS4${this.#secretAccessKey}`, this.shortDate(date));
    const regionKey = hmac(dateKey, this.#region);
    const serviceKey = hmac(regionKey, "s3");
    return hmac(hmac(serviceKey, "aws4_request"), stringToSign);
  }
}
