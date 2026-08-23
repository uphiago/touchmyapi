const ENCRYPTION_ERROR = "credential encryption failed";
const DECRYPTION_ERROR = "credential decryption failed";
const VERSION = 1 as const;
const ALGORITHM = "AES-256-GCM" as const;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BITS = 128;

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

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }

  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  // Reject non-canonical encodings (including values with non-zero discarded bits).
  if (encodeBase64Url(bytes) !== value) throw new Error("invalid base64url");
  return bytes;
}

function canonicalContext(context: CredentialContext): Uint8Array<ArrayBuffer> {
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

  const canonical = JSON.stringify({
    accountId: context.accountId,
    assessmentId: context.assessmentId,
    credentialId: context.credentialId,
    purpose: context.purpose,
  });
  const encoded = new TextEncoder().encode(canonical);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return bytes;
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
  return globalThis.crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);
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

  const nonce = decodeBase64Url(envelope.nonce);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength < AUTH_TAG_BITS / 8)
    throw new Error("invalid envelope");
  return { nonce, ciphertext };
}

export async function encryptCredential(
  provider: KeyProvider,
  keyId: string,
  plaintext: string,
  context: CredentialContext,
): Promise<CredentialEnvelope> {
  try {
    if (typeof plaintext !== "string") throw new Error("invalid plaintext");
    const additionalData = canonicalContext(context);
    const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
    globalThis.crypto.getRandomValues(nonce);
    const key = await importKey(provider, keyId, "encrypt");
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData, tagLength: AUTH_TAG_BITS },
      key,
      new TextEncoder().encode(plaintext),
    );

    return {
      version: VERSION,
      algorithm: ALGORITHM,
      keyId,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    };
  } catch {
    return fail(ENCRYPTION_ERROR);
  }
}

export async function decryptCredential(
  provider: KeyProvider,
  envelope: CredentialEnvelope,
  context: CredentialContext,
): Promise<string> {
  try {
    const { nonce, ciphertext } = validateEnvelope(envelope);
    const additionalData = canonicalContext(context);
    const key = await importKey(provider, envelope.keyId, "decrypt");
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData, tagLength: AUTH_TAG_BITS },
      key,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return fail(DECRYPTION_ERROR);
  }
}
