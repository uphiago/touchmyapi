import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config";

const queue = "postgres://queue_connector:queue-secret-long@127.0.0.1:5433/touchmyapi";
const worker = "postgres://worker_connector:worker-secret-long@127.0.0.1:5433/touchmyapi";

describe("worker configuration", () => {
  it("accepts the explicit development fixture boundary", () => {
    expect(
      loadWorkerConfig({
        NODE_ENV: "development",
        RUNNER_MODE: "fixture",
        QUEUE_DATABASE_URL: queue,
        WORKER_DATABASE_URL: worker,
        WORKER_ID: "local-worker",
      }),
    ).toMatchObject({
      environment: "development",
      runnerMode: "fixture",
      workerId: "local-worker",
      port: 3002,
    });
  });

  it("rejects fixture production and role-confused database URLs", () => {
    expect(() =>
      loadWorkerConfig({
        NODE_ENV: "production",
        RUNNER_MODE: "fixture",
        QUEUE_DATABASE_URL: queue,
        WORKER_DATABASE_URL: worker,
      }),
    ).toThrow(/fixture/i);
    expect(() =>
      loadWorkerConfig({
        NODE_ENV: "development",
        RUNNER_MODE: "fixture",
        QUEUE_DATABASE_URL: worker,
        WORKER_DATABASE_URL: worker,
      }),
    ).toThrow(/QUEUE_DATABASE_URL/i);
  });
});
