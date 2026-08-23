import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  type CredentialContext,
  type CredentialEnvelope,
  type KeyProvider,
} from "../src/aead";

const key = new Uint8Array(32).fill(7);
const rotatedKey = new Uint8Array(32).fill(8);
const context: CredentialContext = {
  accountId: "account-a",
  assessmentId: "assessment-a",
  credentialId: "credential-a",
  purpose: "api",
};

const provider: KeyProvider = {
  getKey: async (keyId) => (keyId === "k1" ? key : undefined),
};

const expectStableError = async (operation: Promise<unknown>, ...secrets: string[]) => {
  await expect(operation).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof Error)) return false;
    if (
      error.message !== "credential decryption failed" &&
      error.message !== "credential encryption failed"
    )
      return false;
    const rendered = String(error);
    return secrets.every((secret) => !rendered.includes(secret));
  });
};

describe("credential AEAD", () => {
  it("round-trips UTF-8 plaintext and uses a unique nonce", async () => {
    const plaintext = "秘密 🔐 \u0000";
    const one = await encryptCredential(provider, "k1", plaintext, context);
    const two = await encryptCredential(provider, "k1", plaintext, context);

    expect(one).toMatchObject({ version: 1, algorithm: "AES-256-GCM", keyId: "k1" });
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.ciphertext).not.toBe(plaintext);
    expect(await decryptCredential(provider, one, context)).toBe(plaintext);
    expect(await decryptCredential(provider, two, context)).toBe(plaintext);
  });

  it("round-trips an empty plaintext", async () => {
    const envelope = await encryptCredential(provider, "k1", "", context);
    expect(await decryptCredential(provider, envelope, context)).toBe("");
  });

  it("binds every context field as authenticated data", async () => {
    const envelope = await encryptCredential(provider, "k1", "secret-value", context);

    for (const field of ["accountId", "assessmentId", "credentialId", "purpose"] as const) {
      await expectStableError(
        decryptCredential(provider, envelope, { ...context, [field]: `different-${field}` }),
        "secret-value",
        "different",
        "k1",
      );
    }
  });

  it("rejects tampering of every envelope field", async () => {
    const envelope = await encryptCredential(provider, "k1", "secret-value", context);
    const tamperBase64 = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    const tampered: Array<CredentialEnvelope | Record<string, unknown>> = [
      { ...envelope, version: 2 },
      { ...envelope, algorithm: "AES-128-GCM" },
      { ...envelope, keyId: "unknown-key" },
      { ...envelope, nonce: tamperBase64(envelope.nonce) },
      { ...envelope, ciphertext: tamperBase64(envelope.ciphertext) },
    ];

    for (const candidate of tampered) {
      await expectStableError(
        decryptCredential(provider, candidate as CredentialEnvelope, context),
        "secret-value",
        "k1",
      );
    }
  });

  it("rejects missing, unknown, and rotated keys", async () => {
    const envelope = await encryptCredential(provider, "k1", "secret-value", context);
    const missing: KeyProvider = { getKey: async () => undefined };
    const throwing: KeyProvider = {
      getKey: async () => {
        throw new Error("provider secret-value key");
      },
    };
    const rotated: KeyProvider = { getKey: async () => rotatedKey };

    await expectStableError(decryptCredential(missing, envelope, context), "secret-value", "k1");
    await expectStableError(
      decryptCredential(throwing, envelope, context),
      "provider secret-value key",
      "secret-value",
    );
    await expectStableError(decryptCredential(rotated, envelope, context), "secret-value", "k1");
  });

  it("rejects keys that are not exactly 32 bytes", async () => {
    const shortKey: KeyProvider = { getKey: async () => new Uint8Array(31) };
    const longKey: KeyProvider = { getKey: async () => new Uint8Array(33) };

    await expectStableError(
      encryptCredential(shortKey, "short", "secret-value", context),
      "secret-value",
      "short",
    );
    await expectStableError(
      encryptCredential(longKey, "long", "secret-value", context),
      "secret-value",
      "long",
    );
  });

  it("rejects malformed envelopes and does not reveal failure details", async () => {
    const envelope = await encryptCredential(provider, "k1", "secret-value", context);
    const malformed: Array<CredentialEnvelope | Record<string, unknown>> = [
      { ...envelope, nonce: "%%%" },
      { ...envelope, nonce: "A" },
      { ...envelope, ciphertext: "%%%" },
      { ...envelope, ciphertext: "" },
      { ...envelope, version: "1" },
      { ...envelope, algorithm: "aes-256-gcm" },
      { ...envelope, keyId: "" },
      { ...envelope, extra: "unexpected" },
      { version: 1, algorithm: "AES-256-GCM", keyId: "k1", nonce: envelope.nonce },
    ];

    for (const candidate of malformed) {
      await expectStableError(
        decryptCredential(provider, candidate as CredentialEnvelope, context),
        "secret-value",
        "k1",
      );
    }
  });

  it("rejects malformed encryption inputs with stable errors", async () => {
    const badProvider = undefined as unknown as KeyProvider;
    await expectStableError(
      encryptCredential(badProvider, "k1", "secret-value", context),
      "secret-value",
      "k1",
    );
    await expectStableError(
      encryptCredential(provider, "", "secret-value", context),
      "secret-value",
    );
    await expectStableError(
      encryptCredential(provider, "k1", "secret-value", {
        ...context,
        purpose: null as unknown as string,
      }),
      "secret-value",
    );
  });
});
