import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SqsEventPublisher } from "../../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import {
  buildBatchPublisher,
  FaultyPublisher,
  MutableClock,
  OUTBOX_BASE_TIME,
  readOutbox,
  seedOutbox,
} from "../../support/outbox";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { createTestQueues, eventIdsOf, receiveUntil, type TestQueues } from "../../support/sqs";

let queues: TestQueues;
let sqsPublisher: SqsEventPublisher;
let db: TestDatabaseContext;
let ctx: PersistenceTestContext;

// Fila e banco novos por teste: o claim é global à tabela e a fila acumularia mensagens de outro teste
beforeEach(async () => {
  queues = await createTestQueues();
  sqsPublisher = new SqsEventPublisher(
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

describe("OutboxBatchPublisher", () => {
  it("publishes pending events to the events queue and marks them published", async () => {
    const eventIds = await seedOutbox(ctx, 5);
    const batch = buildBatchPublisher(ctx, sqsPublisher, { batchSize: 10 });

    const result = await batch.runOnce();

    expect(result).toEqual({ claimed: 5, published: 5, failed: 0 });
    const received = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (all) => new Set(eventIdsOf(all)).size >= eventIds.length,
    );
    expect(eventIdsOf(received).sort()).toEqual([...eventIds].sort());

    const rows = await readOutbox(db);
    for (const eventId of eventIds) {
      expect(rows.get(eventId)!.publishedAt).not.toBeNull();
      expect(rows.get(eventId)!.nextAttemptAt).toBeNull();
    }
    expect(await batch.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it("claims at most one batch per cycle", async () => {
    await seedOutbox(ctx, 7);
    const batch = buildBatchPublisher(ctx, sqsPublisher, { batchSize: 3 });

    expect((await batch.runOnce()).claimed).toBe(3);
    expect((await batch.runOnce()).claimed).toBe(3);
    expect((await batch.runOnce()).claimed).toBe(1);
    expect((await batch.runOnce()).claimed).toBe(0);
  });

  it("counts attempts and schedules the next one with exponential backoff", async () => {
    const [eventId] = await seedOutbox(ctx, 1);
    const clock = new MutableClock(OUTBOX_BASE_TIME);
    const flaky = new FaultyPublisher(sqsPublisher, { failFirst: 2 });
    const batch = buildBatchPublisher(ctx, flaky, { batchSize: 10, clock });
    const at = (ms: number) => new Date(OUTBOX_BASE_TIME.getTime() + ms);

    // Falha 1: attempts=1, próxima em +1s
    expect(await batch.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    let row = (await readOutbox(db)).get(eventId!)!;
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toEqual(at(1000));
    expect(row.publishedAt).toBeNull();

    // Antes do vencimento a linha não é reclamada
    clock.set(at(999));
    expect((await batch.runOnce()).claimed).toBe(0);

    // Falha 2: attempts=2, próxima em +2s a partir de agora
    clock.set(at(1000));
    expect(await batch.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    row = (await readOutbox(db)).get(eventId!)!;
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt).toEqual(at(3000));

    // Sucesso: publicada, e a contagem de tentativas falhas fica registrada
    clock.set(at(3000));
    expect(await batch.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    row = (await readOutbox(db)).get(eventId!)!;
    expect(row.attempts).toBe(2);
    expect(row.publishedAt).toEqual(at(3000));
    expect(row.nextAttemptAt).toBeNull();
    expect(flaky.calls).toEqual([eventId!, eventId!, eventId!]);
  });

  it("keeps the successes of a batch when one message fails", async () => {
    const [first, second, third] = await seedOutbox(ctx, 3);
    const flaky = new FaultyPublisher(sqsPublisher, { failWhen: (message) => message.id === second });
    const batch = buildBatchPublisher(ctx, flaky, { batchSize: 10 });

    expect(await batch.runOnce()).toEqual({ claimed: 3, published: 2, failed: 1 });

    const rows = await readOutbox(db);
    expect(rows.get(first!)!.publishedAt).not.toBeNull();
    expect(rows.get(third!)!.publishedAt).not.toBeNull();
    expect(rows.get(second!)!.publishedAt).toBeNull();
    expect(rows.get(second!)!.attempts).toBe(1);

    const received = await receiveUntil(queues.client, queues.eventsUrl, (all) => all.length >= 2);
    expect(eventIdsOf(received).sort()).toEqual([first!, third!].sort());
  });
});
