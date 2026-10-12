import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OutboxPublisherWorker } from "../../../src/messaging/application/outbox-publisher.worker";
import { SqsEventPublisher } from "../../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { waitFor } from "../../support/parallel";
import { buildBatchPublisher, readOutbox, seedOutbox } from "../../support/outbox";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { createTestQueues, eventIdsOf, receiveUntil, type TestQueues } from "../../support/sqs";

let queues: TestQueues;
let publisher: SqsEventPublisher;
let db: TestDatabaseContext;
let ctx: PersistenceTestContext;

beforeEach(async () => {
  queues = await createTestQueues();
  publisher = new SqsEventPublisher(
    queues.client,
    new SqsQueueUrlResolver(queues.client, queues.eventsQueueName),
  );
  db = await createTestDatabase();
  ctx = await createPersistenceTestContext(db);
});

afterEach(async () => {
  await ctx.app.close();
  await db.teardown();
  await queues.teardown();
});

const silentLogger = () => new AppLogger({ level: "silent" });

async function pendingCount(): Promise<number> {
  return [...(await readOutbox(db)).values()].filter((row) => row.publishedAt === null).length;
}

describe("OutboxPublisherWorker", () => {
  it("drains the outbox in batches and stops gracefully", async () => {
    const eventIds = await seedOutbox(ctx, 25);
    const worker = new OutboxPublisherWorker(
      buildBatchPublisher(ctx, publisher, { batchSize: 10 }),
      silentLogger(),
      { enabled: true, pollIntervalMs: 20, batchSize: 10 },
    );

    worker.start();
    await waitFor(async () => (await pendingCount()) === 0, { description: "outbox drained" });
    await worker.stop();

    const received = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (all) => new Set(eventIdsOf(all)).size >= eventIds.length,
    );
    expect(new Set(eventIdsOf(received))).toEqual(new Set(eventIds));
  });

  it("picks up events enqueued after it started", async () => {
    const worker = new OutboxPublisherWorker(
      buildBatchPublisher(ctx, publisher, { batchSize: 10 }),
      silentLogger(),
      { enabled: true, pollIntervalMs: 20, batchSize: 10 },
    );
    worker.start();

    const eventIds = await seedOutbox(ctx, 3);
    await waitFor(async () => (await pendingCount()) === 0, { description: "late events published" });
    await worker.stop();

    expect(eventIds).toHaveLength(3);
  });

  it("does nothing when the publisher role is disabled", async () => {
    await seedOutbox(ctx, 2);
    const worker = new OutboxPublisherWorker(
      buildBatchPublisher(ctx, publisher, { batchSize: 10 }),
      silentLogger(),
      { enabled: false, pollIntervalMs: 20, batchSize: 10 },
    );

    worker.start();
    await worker.stop();

    expect(await pendingCount()).toBe(2);
  });

  it("keeps running after a failed cycle", async () => {
    await seedOutbox(ctx, 1);
    let failures = 1;
    const batch = buildBatchPublisher(ctx, publisher, { batchSize: 10 });
    const original = batch.runOnce.bind(batch);
    batch.runOnce = async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database unavailable");
      }
      return original();
    };
    const worker = new OutboxPublisherWorker(batch, silentLogger(), {
      enabled: true,
      pollIntervalMs: 20,
      batchSize: 10,
    });

    worker.start();
    await waitFor(async () => (await pendingCount()) === 0, { description: "recovery after failed cycle" });
    await worker.stop();

    expect(failures).toBe(0);
  });
});
