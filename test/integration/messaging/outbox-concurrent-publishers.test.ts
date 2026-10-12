import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EventPublisher } from "../../../src/messaging/application/event-publisher.port";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message";
import { SqsEventPublisher } from "../../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import type { UnitOfWork } from "../../../src/shared/application/unit-of-work.port";
import { createBarrier } from "../../support/barrier";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { buildBatchPublisher, OUTBOX_BASE_TIME, readOutbox, seedOutbox } from "../../support/outbox";
import { runInParallel } from "../../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { createTestQueues, eventIdsOf, receiveUntil, type TestQueues } from "../../support/sqs";

let queues: TestQueues;
let sqsPublisher: SqsEventPublisher;
let db: TestDatabaseContext;
let ctx: PersistenceTestContext;

// Pool folgado: dois publishers seguram uma transação cada enquanto o teste lê o estado
beforeEach(async () => {
  queues = await createTestQueues();
  sqsPublisher = new SqsEventPublisher(
    queues.client,
    new SqsQueueUrlResolver(queues.client, queues.eventsQueueName),
  );
  db = await createTestDatabase({ poolMax: 20 });
  ctx = await createPersistenceTestContext(db);
});

afterEach(async () => {
  await ctx.app.close();
  await db.teardown();
  await queues.teardown();
});

/** Registra cada tentativa de envio e delega ao adaptador SQS real. */
class RecordingPublisher implements EventPublisher {
  public readonly calls: string[] = [];

  constructor(
    private readonly inner: EventPublisher,
    private readonly beforeFirstPublish?: () => Promise<void>,
  ) {}

  private first = true;

  public async publish(message: OutboxMessage): Promise<void> {
    if (this.first) {
      this.first = false;
      await this.beforeFirstPublish?.();
    }
    this.calls.push(message.id);
    await this.inner.publish(message);
  }
}

/** Simula a morte do processo depois do envio e antes do commit: aborta a transação do ciclo. */
class CrashBeforeCommitUnitOfWork implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  public run<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.run(async () => {
      await fn();
      throw new Error("simulated crash before commit");
    });
  }

  public afterCommit(fn: () => void | Promise<void>): void {
    this.inner.afterCommit(fn);
  }
}

/** Consumidor de teste: descarta repetições do mesmo `eventId`, como o consumidor real deve fazer. */
function deduplicateByEventId(eventIds: string[]): string[] {
  return [...new Set(eventIds)];
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

describe("concurrent outbox publishers", () => {
  it("never hands the same row to two simultaneous batches and publishes every event", async () => {
    const eventIds = await seedOutbox(ctx, 60);
    // Cada publisher só envia depois que o outro também está com o seu lote reclamado e aberto
    const bothHoldingClaims = createBarrier(2);
    const recorders = [
      new RecordingPublisher(sqsPublisher, bothHoldingClaims),
      new RecordingPublisher(sqsPublisher, bothHoldingClaims),
    ];
    const batches = recorders.map((recorder) => buildBatchPublisher(ctx, recorder, { batchSize: 5 }));

    await runInParallel(2, async (index) => {
      while ((await batches[index]!.runOnce()).claimed > 0) {
        // continua até a outbox esvaziar
      }
    });

    // Cada linha foi enviada exatamente uma vez: dois lotes simultâneos nunca receberam a mesma
    const sendCounts = countBy(recorders.flatMap((recorder) => recorder.calls));
    expect([...sendCounts.keys()].sort()).toEqual([...eventIds].sort());
    expect([...sendCounts.values()].every((count) => count === 1)).toBe(true);
    // Os dois realmente trabalharam (a barreira só abre com os dois no meio do lote)
    expect(recorders[0]!.calls.length).toBeGreaterThan(0);
    expect(recorders[1]!.calls.length).toBeGreaterThan(0);

    const rows = await readOutbox(db);
    expect(rows.size).toBe(eventIds.length);
    for (const row of rows.values()) {
      expect(row.publishedAt).not.toBeNull();
      expect(row.attempts).toBe(0);
    }

    const received = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (all) => new Set(eventIdsOf(all)).size >= eventIds.length,
    );
    // Todo eventId chegou à fila pelo menos uma vez
    expect(new Set(eventIdsOf(received))).toEqual(new Set(eventIds));
  });

  it("keeps the row pending after a crash between publish and commit and republishes it elsewhere", async () => {
    const eventIds = await seedOutbox(ctx, 3);
    const crashing = new RecordingPublisher(sqsPublisher);
    const crashedBatch = buildBatchPublisher(ctx, crashing, {
      batchSize: 10,
      unitOfWork: new CrashBeforeCommitUnitOfWork(ctx.unitOfWork),
    });

    await expect(crashedBatch.runOnce()).rejects.toThrow("simulated crash before commit");

    // Os envios aconteceram, mas nada foi commitado: tudo segue pendente, sem tentativa registrada
    expect(crashing.calls.sort()).toEqual([...eventIds].sort());
    for (const row of (await readOutbox(db)).values()) {
      expect(row.publishedAt).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.nextAttemptAt).toBeNull();
    }

    // Outra instância assume e publica de novo
    const takeover = new RecordingPublisher(sqsPublisher);
    const result = await buildBatchPublisher(ctx, takeover, { batchSize: 10 }).runOnce();

    expect(result).toEqual({ claimed: 3, published: 3, failed: 0 });
    for (const row of (await readOutbox(db)).values()) {
      expect(row.publishedAt).not.toBeNull();
    }

    // At-least-once: cada evento foi enviado duas vezes ao broker
    const sendCounts = countBy([...crashing.calls, ...takeover.calls]);
    for (const eventId of eventIds) {
      expect(sendCounts.get(eventId)).toBe(2);
    }

    // O FIFO pode colapsar a repetição (mesma MessageDeduplicationId); a fila contém cada evento
    // pelo menos uma vez e o consumidor que deduplica por eventId obtém exatamente um de cada
    const received = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (all) => new Set(eventIdsOf(all)).size >= eventIds.length,
    );
    const arrived = eventIdsOf(received);
    for (const eventId of eventIds) {
      expect(arrived.filter((id) => id === eventId).length).toBeGreaterThanOrEqual(1);
    }
    expect(deduplicateByEventId(arrived).sort()).toEqual([...eventIds].sort());
  });

  it("does not see an event before the transaction that created it commits", async () => {
    const recorder = new RecordingPublisher(sqsPublisher);
    const publisher = buildBatchPublisher(ctx, recorder, { batchSize: 10 });
    const eventId = ctx.idGenerator.generate();
    const aggregateId = ctx.idGenerator.generate();

    let markEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      markEnqueued = resolve;
    });
    let commit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // Transação "financeira" aberta: o evento já foi gravado, mas ainda não commitado
    const financialTransaction = ctx.unitOfWork.run(async () => {
      await ctx.outboxRepo.enqueue(
        OutboxMessage.rehydrate({
          id: eventId,
          aggregateId,
          eventType: "WalletBalanceChanged",
          payload: { eventId, aggregateId },
          occurredAt: OUTBOX_BASE_TIME,
          attempts: 0,
        }),
      );
      markEnqueued();
      await commitGate;
    });
    await enqueued;

    expect(await publisher.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(recorder.calls).toEqual([]);

    commit();
    await financialTransaction;

    expect(await publisher.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(recorder.calls).toEqual([eventId]);
  });
});
