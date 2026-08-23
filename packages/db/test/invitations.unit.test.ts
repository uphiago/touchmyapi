import { describe, expect, it } from "vitest";
import {
  createInvitationToken,
  hashInvitationToken,
  invitationTokenPattern,
} from "../src/invitations";

describe("invitation token boundary", () => {
  it("creates 256-bit URL-safe tokens and only returns their hash for persistence", async () => {
    const first = await createInvitationToken();
    const second = await createInvitationToken();
    expect(invitationTokenPattern.test(first.token)).toBe(true);
    expect(invitationTokenPattern.test(second.token)).toBe(true);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.tokenHash).toBe(await hashInvitationToken(first.token));
    expect(first).not.toHaveProperty("url");
  });

  it("rejects malformed tokens and does not expose raw values in errors", async () => {
    await expect(hashInvitationToken("not-a-token")).rejects.toThrow("invalid invitation token");
    await expect(hashInvitationToken("A".repeat(43))).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });
});
