import { describe, expect, it } from "vitest";
import { app } from "../../apps/api/src/app";

describe("execution surface isolation", () => {
  it.each(["/api/v1/assessments", "/api/v1/jobs", "/api/v1/run"])(
    "returns 404 for %s until an execution surface is explicitly implemented",
    async (path) => {
      const response = await app.request(`http://localhost${path}`);

      expect(response.status).toBe(404);
    },
  );
});
