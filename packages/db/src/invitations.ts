const TEXT = new TextEncoder();

export const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function validateToken(token: string): void {
  if (typeof token !== "string" || !invitationTokenPattern.test(token)) {
    throw new TypeError("invalid invitation token");
  }
}

/** Create a raw token for one-time delivery and its SHA-256 persistence value. */
export async function createInvitationToken(): Promise<{
  readonly token: string;
  readonly tokenHash: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  try {
    const token = encode(bytes);
    return Object.freeze({ token, tokenHash: await hashInvitationToken(token) });
  } finally {
    bytes.fill(0);
  }
}

/** Hash only an explicit body token; callers must never persist or log the raw value. */
export async function hashInvitationToken(token: string): Promise<string> {
  validateToken(token);
  const source = TEXT.encode(token);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
    try {
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } finally {
      digest.fill(0);
    }
  } finally {
    source.fill(0);
  }
}
