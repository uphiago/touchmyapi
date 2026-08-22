import { describe, expect, it } from "vitest";
import { app } from "../src/app";

describe("GET /health", () => {
  it("returns service health without authentication", async () => {
    const response = await app.request("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
