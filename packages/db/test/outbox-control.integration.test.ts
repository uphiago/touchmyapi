import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import {
  ackOutboxEvent,
  claimOutboxEvents,
  failOutboxEvent,
  heartbeatOutboxEvent,
} from "../src/queue-control";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for outbox control tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Outbox control tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("standalone outbox control boundary", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("claims, heartbeats, and acknowledges without touching queue counters", async () => {
    const accountId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = new Date("2026-08-23T12:00:00.000Z");
    try {
      await db.unsafe("insert into public.account (id) values ($1::uuid)", [accountId]);
      await db.unsafe(
        "insert into public.outbox_event (id, account_id, event_key, aggregate_type, aggregate_id, schema_version, payload_json, status, attempts, max_attempts, available_at, fencing_token) values ($1::uuid, $2::uuid, $3, 'test', null, 'test@1', '{}'::jsonb, 'pending', 0, 3, $4, 0)",
        [eventId, accountId, "outbox:" + eventId, now],
      );
      const [claimed] = await claimOutboxEvents(db, "outbox-worker", 10, now);
      expect(claimed).toMatchObject({
        id: eventId,
        accountId,
        eventKey: "outbox:" + eventId,
        leaseOwner: "outbox-worker",
        fencingToken: 1,
      });
      expect(
        await heartbeatOutboxEvent(db, accountId, eventId, "outbox-worker", 1, now),
      ).toMatchObject({
        id: eventId,
        fencingToken: 1,
      });
      expect(await ackOutboxEvent(db, accountId, eventId, "outbox-worker", 99, now)).toBe(false);
      expect(await ackOutboxEvent(db, accountId, eventId, "outbox-worker", 1, now)).toBe(true);
      const [event] = await db.unsafe(
        "select status, attempts, fencing_token, lease_owner from public.outbox_event where id = $1::uuid",
        [eventId],
      );
      expect(event).toEqual({
        status: "processed",
        attempts: 0,
        fencing_token: 1,
        lease_owner: null,
      });
      const [global] = await db.unsafe("select running_count from public.queue_global_state");
      expect(global).toEqual({ running_count: 0 });
    } finally {
      await db.unsafe("delete from public.outbox_event where id = $1::uuid", [eventId]);
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });

  it("fails an event with bounded retry state and stale fences are no-ops", async () => {
    const accountId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = new Date("2026-08-23T12:00:00.000Z");
    try {
      await db.unsafe("insert into public.account (id) values ($1::uuid)", [accountId]);
      await db.unsafe(
        "insert into public.outbox_event (id, account_id, event_key, aggregate_type, schema_version, payload_json, status, attempts, max_attempts, available_at, fencing_token) values ($1::uuid, $2::uuid, $3, 'test', 'test@1', '{}'::jsonb, 'pending', 0, 3, $4, 0)",
        [eventId, accountId, "retry:" + eventId, now],
      );
      const [claimed] = await claimOutboxEvents(db, "retry-worker", 1, now);
      if (!claimed) throw new Error("outbox claim fixture missing");
      expect(await failOutboxEvent(db, accountId, eventId, "retry-worker", 99, "stale", now)).toBe(
        false,
      );
      expect(
        await failOutboxEvent(
          db,
          accountId,
          eventId,
          "retry-worker",
          claimed.fencingToken,
          "temporary",
          now,
        ),
      ).toBe(true);
      const [event] = await db.unsafe(
        "select status, attempts, last_error, fencing_token from public.outbox_event where id = $1::uuid",
        [eventId],
      );
      expect(event).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "temporary",
        fencing_token: 1,
      });
    } finally {
      await db.unsafe("delete from public.outbox_event where id = $1::uuid", [eventId]);
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });
});
