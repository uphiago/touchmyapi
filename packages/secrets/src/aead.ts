const ENCRYPTION_ERROR = "credential encryption failed";
const DECRYPTION_ERROR = "credential decryption failed";
const VERSION = 2 as const;
const ALGORITHM = "AES-256-GCM" as const;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BITS = 128;
const AUTH_TAG_BYTES = AUTH_TAG_BITS / 8;
const MAX_FIELD_BYTES = 256;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES;

function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

export type KeyProvider = {
  getKey: (keyId: string) => Promise<Uint8Array | undefined>;
};

export type CredentialContext = {
  accountId: string;
  assessmentId: string;
  credentialId: string;
  purpose: string;
};

export type CredentialEnvelope = {
  version: typeof VERSION;
  algorithm: typeof ALGORITHM;
  keyId: string;
  nonce: string;
  ciphertext: string;
};

function fail(message: typeof ENCRYPTION_ERROR | typeof DECRYPTION_ERROR): never {
  throw new Error(message);
}

// Best-effort zeroization; JavaScript GC may retain copies outside this module's control.
function zeroize(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(
  value: unknown,
  limits: {
    exactEncodedLength?: number;
    minEncodedLength?: number;
    maxEncodedLength?: number;
  } = {},
): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") throw new Error("invalid base64url");
  if (limits.exactEncodedLength !== undefined && value.length !== limits.exactEncodedLength) {
    throw new Error("invalid base64url");
  }
  if (limits.minEncodedLength !== undefined && value.length < limits.minEncodedLength) {
    throw new Error("invalid base64url");
  }
  if (limits.maxEncodedLength !== undefined && value.length > limits.maxEncodedLength) {
    throw new Error("invalid base64url");
  }
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }

  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const binary = globalThis.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

    // Reject non-canonical encodings (including values with non-zero discarded bits).
    if (encodeBase64Url(bytes) !== value) throw new Error("invalid base64url");
    return bytes;
  } catch (error) {
    zeroize(bytes);
    throw error;
  }
}

function validateBoundedString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_FIELD_BYTES) {
    throw new Error("invalid bounded string");
  }
  const encoded = new TextEncoder().encode(value);
  try {
    if (encoded.byteLength > MAX_FIELD_BYTES) throw new Error("invalid bounded string");
  } finally {
    zeroize(encoded);
  }
}

function canonicalContext(context: CredentialContext, keyId: string): Uint8Array<ArrayBuffer> {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof context.accountId !== "string" ||
    typeof context.assessmentId !== "string" ||
    typeof context.credentialId !== "string" ||
    typeof context.purpose !== "string"
  ) {
    throw new Error("invalid credential context");
  }
  validateBoundedString(keyId);
  if (keyId.length === 0) throw new Error("invalid credential context");
  validateBoundedString(context.accountId);
  validateBoundedString(context.assessmentId);
  validateBoundedString(context.credentialId);
  validateBoundedString(context.purpose);

  const canonical = JSON.stringify({
    accountId: context.accountId,
    assessmentId: context.assessmentId,
    credentialId: context.credentialId,
    purpose: context.purpose,
    keyId,
  });
  const encoded = new TextEncoder().encode(canonical);
  try {
    const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    bytes.set(encoded);
    return bytes;
  } finally {
    zeroize(encoded);
  }
}

function copyKey(key: unknown): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES)
    throw new Error("invalid credential key");
  const bytes = new Uint8Array(new ArrayBuffer(KEY_BYTES));
  bytes.set(key);
  return bytes;
}

async function importKey(
  provider: KeyProvider,
  keyId: string,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (
    provider === null ||
    typeof provider !== "object" ||
    typeof provider.getKey !== "function" ||
    typeof keyId !== "string" ||
    keyId.length === 0
  ) {
    throw new Error("invalid key provider");
  }
  const key = copyKey(await provider.getKey(keyId));
  try {
    return await globalThis.crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
      usage,
    ]);
  } finally {
    zeroize(key);
  }
}

function validateEnvelope(envelope: CredentialEnvelope): {
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
} {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("invalid envelope");

  const keys = Object.keys(envelope as object).sort();
  if (keys.join(",") !== "algorithm,ciphertext,keyId,nonce,version")
    throw new Error("invalid envelope");
  if (
    envelope.version !== VERSION ||
    envelope.algorithm !== ALGORITHM ||
    typeof envelope.keyId !== "string" ||
    envelope.keyId.length === 0
  ) {
    throw new Error("invalid envelope");
  }
  validateBoundedString(envelope.keyId);
  if (envelope.keyId.length === 0) throw new Error("invalid envelope");

  let nonce: Uint8Array<ArrayBuffer> | undefined;
  let ciphertext: Uint8Array<ArrayBuffer> | undefined;
  let valid = false;
  try {
    nonce = decodeBase64Url(envelope.nonce, {
      exactEncodedLength: base64UrlLength(NONCE_BYTES),
    });
    ciphertext = decodeBase64Url(envelope.ciphertext, {
      minEncodedLength: base64UrlLength(AUTH_TAG_BYTES),
      maxEncodedLength: base64UrlLength(MAX_CIPHERTEXT_BYTES),
    });
    if (
      nonce.byteLength !== NONCE_BYTES ||
      ciphertext.byteLength < AUTH_TAG_BYTES ||
      ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
    )
      throw new Error("invalid envelope");
    valid = true;
    return { nonce, ciphertext };
  } finally {
    if (!valid) {
      zeroize(nonce);
      zeroize(ciphertext);
    }
  }
}

function encodePlaintext(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("invalid plaintext");
  }
  const encoded = new TextEncoder().encode(value);
  try {
    if (encoded.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("invalid plaintext");
    const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    bytes.set(encoded);
    return bytes;
  } finally {
    zeroize(encoded);
  }
}

export async function encryptCredential(
  provider: KeyProvider,
  keyId: string,
  plaintext: string,
  context: CredentialContext,
): Promise<CredentialEnvelope> {
  let additionalData: Uint8Array<ArrayBuffer> | undefined;
  let nonce: Uint8Array<ArrayBuffer> | undefined;
  let plaintextBytes: Uint8Array<ArrayBuffer> | undefined;
  let ciphertextBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    plaintextBytes = encodePlaintext(plaintext);
    additionalData = canonicalContext(context, keyId);
    nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
    globalThis.crypto.getRandomValues(nonce);
    const key = await importKey(provider, keyId, "encrypt");
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData, tagLength: AUTH_TAG_BITS },
      key,
      plaintextBytes!,
    );
    ciphertextBytes = new Uint8Array(ciphertext);

    return {
      version: VERSION,
      algorithm: ALGORITHM,
      keyId,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertextBytes),
    };
  } catch {
    return fail(ENCRYPTION_ERROR);
  } finally {
    zeroize(additionalData);
    zeroize(nonce);
    zeroize(plaintextBytes);
    zeroize(ciphertextBytes);
  }
}

export async function decryptCredential(
  provider: KeyProvider,
  envelope: CredentialEnvelope,
  context: CredentialContext,
): Promise<string> {
  let additionalData: Uint8Array<ArrayBuffer> | undefined;
  let nonce: Uint8Array<ArrayBuffer> | undefined;
  let ciphertext: Uint8Array<ArrayBuffer> | undefined;
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    const validated = validateEnvelope(envelope);
    nonce = validated.nonce;
    ciphertext = validated.ciphertext;
    additionalData = canonicalContext(context, envelope.keyId);
    const key = await importKey(provider, envelope.keyId, "decrypt");
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData, tagLength: AUTH_TAG_BITS },
      key,
      ciphertext,
    );
    plaintext = new Uint8Array(decrypted);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return fail(DECRYPTION_ERROR);
  } finally {
    zeroize(additionalData);
    zeroize(nonce);
    zeroize(ciphertext);
    zeroize(plaintext);
  }
}
