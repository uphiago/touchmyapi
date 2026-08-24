import { describe, expect, it } from "vitest";
import { isPublicLandingHost } from "./public-host";

describe("public host routing", () => {
  it("keeps the apex and www on the public landing", () => {
    expect(isPublicLandingHost("touchmyapi.com")).toBe(true);
    expect(isPublicLandingHost("www.touchmyapi.com")).toBe(true);
  });

  it("keeps the application and local hosts on the customer console", () => {
    expect(isPublicLandingHost("app.touchmyapi.com")).toBe(false);
    expect(isPublicLandingHost("127.0.0.1")).toBe(false);
    expect(isPublicLandingHost("localhost")).toBe(false);
  });
});
