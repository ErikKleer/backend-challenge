import type { EventPublisher } from "../../src/messaging/application/event-publisher.port";
import { OutboxBatchPublisher } from "../../src/messaging/application/outbox-batch-publisher";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import type { Clock } from "../../src/shared/application/clock.port";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { AppLogger } from "../../src/shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../src/shared/infrastructure/observability/metrics.service";
import type { TestDatabaseContext } from "./database";
import type { PersistenceTestContext } from "./persistence";

export const OUTBOX_BASE_TIME = new Date("2026-07-29T15:00:00.000Z");

export interface OutboxRow {
  id: string;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

/** Relógio controlado pelo teste, para tornar o backoff exato e determinístico. */
export class MutableClock implements Clock {
  constructor(private current: Date) {}

  public now(): Date {
    return this.current;
  }

  public set(value: Date): void {
    this.current = value;
  }
}

/**
 * Grava `count` eventos pendentes na outbox, um por wallet, como o fluxo financeiro faria.
 * Devolve os `eventId` na ordem de criação.
 */
export async function seedOutbox(
  ctx: PersistenceTestContext,
  count: number,
  occurredAt: Date = OUTBOX_BASE_TIME,
): Promise<string[]> {
  const ids: string[] = [];
  await ctx.unitOfWork.run(async () => {
    for (let n = 0; n < count; n += 1) {
      const eventId = ctx.idGenerator.generate();
      const aggregateId = ctx.idGenerator.generate();
      ids.push(eventId);
      await ctx.outboxRepo.enqueue(
        OutboxMessage.rehydrate({
          id: eventId,
          aggregateId,
          eventType: "WalletBalanceChanged",
          payload: {
            eventId,
            eventType: "WalletBalanceChanged",
            aggregateId,
            occurredAt: occurredAt.toISOString(),
            version: 1,
            data: { n },
          },
          occurredAt,
          attempts: 0,
        }),
      );
    }
  });
  return ids;
}

/** Estado persistido da outbox, lido fora de qualquer transação do publisher. */
export async function readOutbox(db: TestDatabaseContext): Promise<Map<string, OutboxRow>> {
  const rows = await db.orm.em.fork().execute<
    Array<{ id: string; attempts: number; next_attempt_at: string | Date | null; published_at: string | Date | null }>
  >("SELECT id, attempts, next_attempt_at, published_at FROM outbox_messages");

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at === null ? null : new Date(row.next_attempt_at),
        publishedAt: row.published_at === null ? null : new Date(row.published_at),
      },
    ]),
  );
}

export function buildBatchPublisher(
  ctx: PersistenceTestContext,
  publisher: EventPublisher,
  options: {
    batchSize: number;
    clock?: Clock;
    unitOfWork?: UnitOfWork;
    metrics?: MetricsService;
    logger?: AppLogger;
  },
): OutboxBatchPublisher {
  return new OutboxBatchPublisher(
    {
      unitOfWork: options.unitOfWork ?? ctx.unitOfWork,
      outbox: ctx.outboxRepo,
      publisher,
      clock: options.clock ?? ctx.clock,
      metrics: options.metrics ?? new MetricsService({ collectDefaults: false }),
      logger: options.logger ?? new AppLogger({ level: "silent" }),
    },
    { batchSize: options.batchSize },
  );
}

/**
 * Envolve o publisher real com falha injetada: as `failFirst` primeiras chamadas (ou as de
 * mensagens escolhidas por `failWhen`) rejeitam sem chegar ao SQS; o resto delega ao real.
 */
export class FaultyPublisher implements EventPublisher {
  public readonly calls: string[] = [];
  private remainingFailures: number;
  private readonly failWhen?: (message: OutboxMessage) => boolean;

  constructor(
    private readonly inner: EventPublisher,
    options: { failFirst?: number; failWhen?: (message: OutboxMessage) => boolean } = {},
  ) {
    this.remainingFailures = options.failFirst ?? 0;
    this.failWhen = options.failWhen;
  }

  public async publish(message: OutboxMessage): Promise<void> {
    this.calls.push(message.id);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("injected publish failure");
    }
    if (this.failWhen?.(message)) {
      throw new Error("injected publish failure");
    }
    await this.inner.publish(message);
  }
}

/** Valor atual de um contador/gauge sem rótulos no registry do `MetricsService`. */
export async function metricValue(metrics: MetricsService, name: string): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) {
    throw new Error(`Unknown metric '${name}'`);
  }
  const { values } = await metric.get();
  return values[0]?.value ?? 0;
}
