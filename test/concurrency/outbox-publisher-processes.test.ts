import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { assertAllWalletsConsistent } from "../support/invariants";
import { seedOutbox } from "../support/outbox";
import { waitFor } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { AppInstance, startInstances, stopAll } from "../support/process";
import { createTestQueues, eventIdsOf, receiveUntil, type TestQueues } from "../support/sqs";
import { WageringHarness } from "../support/wagering";

const WALLETS = 15;
const SEEDED_EVENTS = 120;
const BATCH_SIZE = "5";

describe("outbox publishers running as separate processes", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let queues: TestQueues;
  let started: AppInstance[];

  beforeEach(async () => {
    started = [];
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    queues = await createTestQueues();
  });

  afterEach(async () => {
    await stopAll(started);
    await queues.teardown();
    await ctx.app.close();
    await db.teardown();
  });

  async function scalar(sql: string, params: unknown[] = []): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ value: string }>>(sql, params);
    return row!.value;
  }

  /** Eventos reais (abertura de wallets) e sintéticos, todos ainda pendentes na outbox. */
  async function seedPendingEvents(): Promise<string[]> {
    const harness = new WageringHarness(ctx);
    for (let n = 0; n < WALLETS; n += 1) {
      await harness.createWallet("100.00");
    }
    await seedOutbox(ctx, SEEDED_EVENTS);
    const rows = await db.orm.em.execute<Array<{ id: string }>>("SELECT id FROM outbox_messages");
    return rows.map((row) => row.id);
  }

  const unpublished = async (): Promise<number> =>
    Number(await scalar("SELECT COUNT(*)::text AS value FROM outbox_messages WHERE published_at IS NULL"));

  function publishedByInstance(instance: AppInstance): string[] {
    return instance
      .logs()
      .filter((entry) => entry.msg === "outbox batch published" || entry.msg === "outbox batch finished with failures")
      .flatMap((entry) => (entry.publishedEventIds as string[] | undefined) ?? []);
  }

  it("publishes every event once between two processes, without overlap", async () => {
    // Ambas já estão no laço de publicação quando os eventos aparecem
    const publishers = await startInstances(2, {
      db,
      queues,
      roles: { outboxPublisher: true },
      env: { OUTBOX_BATCH_SIZE: BATCH_SIZE },
    });
    started.push(...publishers);
    const ids = await seedPendingEvents();

    await waitFor(async () => (await unpublished()) === 0, {
      timeoutMs: 60_000,
      description: "both publishers to drain the outbox",
    });

    // O log do lote sai depois do commit: espera a última linha chegar do processo filho
    await waitFor(() => publishers.flatMap(publishedByInstance).length >= ids.length, {
      description: "the publishers' batch logs",
    });

    // Banco: cada linha foi marcada como publicada; nenhuma publicação repetida entre os processos
    const [first, second] = publishers.map(publishedByInstance) as [string[], string[]];
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort()).toEqual([...ids].sort());

    // Fila: todo evento chegou, e cada um uma única vez
    const received = await receiveUntil(queues.client, queues.eventsUrl, (messages) => messages.length >= ids.length);
    expect(eventIdsOf(received).sort()).toEqual([...ids].sort());

    expect(await assertAllWalletsConsistent(db.orm.em)).toBe(WALLETS);
  });

  it("republishes from another process after the first dies between publishing and committing", async () => {
    const ids = await seedPendingEvents();

    const doomed = await AppInstance.start({
      name: "doomed-publisher",
      db,
      queues,
      roles: { outboxPublisher: true },
      env: { OUTBOX_BATCH_SIZE: BATCH_SIZE, FAULT_INJECTION: "after_publish_before_commit=crash" },
    });
    started.push(doomed);
    await doomed.waitForExit();

    // O lote saiu para o SQS, mas a transação morreu junto: nenhuma linha ficou marcada
    expect(await unpublished()).toBe(ids.length);
    const beforeTakeover = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (messages) => messages.length >= Number(BATCH_SIZE),
    );
    expect(beforeTakeover.length).toBeGreaterThanOrEqual(Number(BATCH_SIZE));

    // Outro processo assume e publica tudo, inclusive o lote que já havia saído
    const [takeover] = await startInstances(1, {
      db,
      queues,
      roles: { outboxPublisher: true },
      env: { OUTBOX_BATCH_SIZE: BATCH_SIZE },
    });
    started.push(takeover!);
    await waitFor(async () => (await unpublished()) === 0, {
      timeoutMs: 60_000,
      description: "the takeover publisher to drain the outbox",
    });
    await waitFor(() => publishedByInstance(takeover!).length >= ids.length, {
      description: "the takeover publisher's batch logs",
    });
    expect([...publishedByInstance(takeover!)].sort()).toEqual([...ids].sort());

    // Nenhum evento se perdeu; a duplicata do lote reenviado é inofensiva (mesmo eventId = mesma
    // MessageDeduplicationId, que o FIFO descarta; um consumidor deduplica pelo mesmo eventId)
    const afterTakeover = await receiveUntil(queues.client, queues.eventsUrl, (messages) =>
      new Set([...eventIdsOf(beforeTakeover), ...eventIdsOf(messages)]).size >= ids.length,
    );
    const everyEventId = new Set([...eventIdsOf(beforeTakeover), ...eventIdsOf(afterTakeover)]);
    expect([...everyEventId].sort()).toEqual([...ids].sort());

    expect(await assertAllWalletsConsistent(db.orm.em)).toBe(WALLETS);
  });
});
