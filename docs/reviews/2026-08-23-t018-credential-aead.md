# T018 Credential AEAD Acceptance

**Date:** 2026-08-23  
**Branch:** `feat/foundation-phase2`  
**Commits:** `dda0441..72305f8`  
**Status:** Accepted

## Delivered boundary

- `@touchmyapi/secrets` exposes only typed encrypt/decrypt helpers and an injected `KeyProvider`; it does not read environment variables, persist, log, or depend on a runtime service.
- Envelopes use AES-256-GCM with a fresh 12-byte nonce, canonical base64url, version `2`, and a 16-byte authentication tag.
- AAD binds `accountId`, `assessmentId`, `credentialId`, `purpose`, and `keyId`; changing any context or alias fails closed. Version `1` is rejected explicitly because it predates key-ID authentication and must be re-encrypted.
- Keys are copied and require exactly 32 bytes. Key/context fields are capped at 256 UTF-8 bytes, plaintext at 1 MiB, and nonce/ciphertext are bounded before base64 decoding. Temporary buffers receive best-effort zeroization; JavaScript GC limitations are documented in code.
- Provider, input, and authentication failures normalize to stable generic encryption/decryption errors without plaintext, keys, provider messages, or stack-derived details.

## Review outcome

The specification review and adversarial quality review both returned `Ready: Yes` with no Critical, Important, or Minor findings. The plan was updated in `72305f8` to make the version-2 migration/rejection behavior canonical.

## Verification

- `bun run test:unit -- --maxWorkers=1`: **228/228 passed** (including 12 AEAD tests)
- `bun run typecheck`: passed
- `bun run lint`: passed
- `bun run format`: passed
- `git diff --check`: passed
- Direct Bun Web Crypto round-trip and 8 MiB oversized-ciphertext probe: generic bounded failure without large decode allocation

T019–T021 remain pending; this acceptance does not unlock assessment execution or external target access.
