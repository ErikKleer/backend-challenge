import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";

describe("Database Schema: inbox_messages and outbox_messages", () => {
  let db: TestDatabaseContext;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.teardown();
  });

  describe("inbox_messages", () => {
    it("should insert inbox message and reject duplicate (consumer_name, message_id)", async () => {
      const consumer = "sqs-wager-tx-consumer";
      const messageId = "msg-123456";
      const hash = "a".repeat(64);
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        [consumer, messageId, hash, now],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
           VALUES (?, ?, ?, ?)`,
          [consumer, messageId, hash, now],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/pk_inbox_messages|unique constraint|duplicate key/i);
    });

    it("should allow same message_id for different consumers", async () => {
      const consumer1 = "consumer-alpha";
      const consumer2 = "consumer-beta";
      const messageId = "msg-shared-id";
      const hash = "b".repeat(64);
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        [consumer1, messageId, hash, now],
      );

      await db.orm.em.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        [consumer2, messageId, hash, now],
      );

      const rows = await db.orm.em.execute(
        `SELECT count(*)::int as count FROM inbox_messages WHERE message_id = ?`,
        [messageId],
      );
      expect(rows[0]!.count).toBe(2);
    });
  });

  describe("outbox_messages", () => {
    it("should insert outbox message and query using partial claim index", async () => {
      const eventId = "90000000-0000-0000-0000-000000000001";
      const aggregateId = "80000000-0000-0000-0000-000000000001";
      const eventType = "WagerProcessedEvent";
      const payload = JSON.stringify({ amount: "50.00", currency: "BRL" });

      await db.orm.em.execute(
        `INSERT INTO outbox_messages (
          id, aggregate_id, event_type, payload, occurred_at, attempts
        ) VALUES (?, ?, ?, ?::jsonb, NOW(), ?)`,
        [eventId, aggregateId, eventType, payload, 0],
      );

      const pending = await db.orm.em.execute(
        `SELECT id, aggregate_id, event_type, payload
         FROM outbox_messages
         WHERE published_at IS NULL AND COALESCE(next_attempt_at, occurred_at) <= NOW()`,
      );

      expect(pending.length).toBeGreaterThanOrEqual(1);
      const found = pending.find((p: any) => p.id === eventId);
      expect(found).toBeDefined();
      expect(found!.event_type).toBe(eventType);
    });
  });
});
