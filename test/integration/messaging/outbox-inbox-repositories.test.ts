import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message";
import { WalletBalanceChanged } from "../../../src/messaging/domain/wallet-balance-changed.event";
import { Money } from "../../../src/shared/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";

const BASE = new Date("2026-07-29T15:00:00.000Z");
const at = (seconds: number) => new Date(BASE.getTime() + seconds * 1000);

let db: TestDatabaseContext;
let ctx: PersistenceTestContext;

// Banco novo por teste: claimDue é global à tabela e o ledger/outbox não aceitam limpeza entre testes
beforeEach(async () => {
  db = await createTestDatabase();
  ctx = await createPersistenceTestContext(db);
});

afterEach(async () => {
  await ctx.app.close();
  await db.teardown();
});

function message(n: number, occurredAt: Date): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: ctx.idGenerator.generate(),
    aggregateId: `wallet-${n}`,
    eventType: "TestEvent",
    payload: { n },
    occurredAt,
    attempts: 0,
  });
}

async function seed(messages: OutboxMessage[]): Promise<void> {
  await ctx.unitOfWork.run(async () => {
    for (const m of messages) {
      expect(await ctx.outboxRepo.enqueue(m)).toBe(true);
    }
  });
}

async function countOutbox(): Promise<number> {
  const rows = await db.orm.em.fork().execute<Array<{ n: string }>>(
    "SELECT count(*)::text AS n FROM outbox_messages",
  );
  return Number(rows[0]!.n);
}

describe("OutboxRepository", () => {
  it("should enqueue idempotently by eventId and round-trip the jsonb payload", async () => {
    const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
    const wallet = Wallet.open({
      id: ctx.idGenerator.generate(),
      playerId: "player-1",
      initialBalance: brl("100.00"),
    });
    const entry = wallet.debit({
      entryId: ctx.idGenerator.generate(),
      transactionId: ctx.idGenerator.generate(),
      money: brl("25.00"),
      at: BASE,
    });
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: "corr-1", now: BASE });

    const first = await ctx.unitOfWork.run(() => ctx.outboxRepo.enqueue(OutboxMessage.enqueue(event)));
    const second = await ctx.unitOfWork.run(() => ctx.outboxRepo.enqueue(OutboxMessage.enqueue(event)));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await countOutbox()).toBe(1);

    const [claimed] = await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(1), 10));
    expect(claimed!.id).toBe(event.eventId);
    expect(claimed!.aggregateId).toBe(wallet.id);
    expect(claimed!.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect((claimed!.payload.data as { money: unknown }).money).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  it("should claim only pending messages that are due, oldest first", async () => {
    const old = message(1, at(-30));
    const recent = message(2, at(-10));
    const future = message(3, at(60));
    const published = message(4, at(-20));
    published.markPublished(at(-5));
    await seed([recent, future, published, old]);

    const claimed = await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(0), 10));

    expect(claimed.map((m) => m.id)).toEqual([old.id, recent.id]);
  });

  it("should respect the claim limit", async () => {
    await seed([1, 2, 3, 4, 5].map((n) => message(n, at(-n))));

    const claimed = await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(0), 3));

    expect(claimed).toHaveLength(3);
  });

  it("should persist publication and retry state through save", async () => {
    const toPublish = message(1, at(-10));
    const toRetry = message(2, at(-9));
    await seed([toPublish, toRetry]);

    await ctx.unitOfWork.run(async () => {
      const [a, b] = await ctx.outboxRepo.claimDue(at(0), 10);
      a!.markPublished(at(1));
      b!.scheduleRetry(at(1));
      await ctx.outboxRepo.save(a!);
      await ctx.outboxRepo.save(b!);
    });

    expect(await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(1), 10))).toEqual([]);

    const [retried] = await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(2), 10));
    expect(retried!.id).toBe(toRetry.id);
    expect(retried!.attempts).toBe(1);
    expect(retried!.nextAttemptAt).toEqual(at(2));
  });

  it("should never hand the same row to two simultaneous transactions", async () => {
    const all = Array.from({ length: 10 }, (_, i) => message(i, at(-100 + i)));
    await seed(all);

    let aClaimed!: () => void;
    const aClaimedSignal = new Promise<void>((resolve) => {
      aClaimed = resolve;
    });
    let releaseA!: () => void;
    const releaseASignal = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A reclama 5 linhas e mantém a transação aberta (locks retidos)
    const txA = ctx.unitOfWork.run(async () => {
      const claimed = await ctx.outboxRepo.claimDue(at(0), 5);
      aClaimed();
      await releaseASignal;
      return claimed.map((m) => m.id);
    });

    await aClaimedSignal;

    // B pede mais do que existe e termina sem esperar A: SKIP LOCKED pula as linhas de A
    const idsB = await ctx.unitOfWork.run(async () => {
      const claimed = await ctx.outboxRepo.claimDue(at(0), 10);
      return claimed.map((m) => m.id);
    });

    releaseA();
    const idsA = await txA;

    expect(idsA).toHaveLength(5);
    expect(idsB).toHaveLength(5);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(new Set([...idsA, ...idsB])).toEqual(new Set(all.map((m) => m.id)));
  });

  it("should release rows for the next claim when the claiming transaction rolls back", async () => {
    await seed([message(1, at(-10))]);

    await expect(
      ctx.unitOfWork.run(async () => {
        const claimed = await ctx.outboxRepo.claimDue(at(0), 10);
        claimed[0]!.markPublished(at(0));
        await ctx.outboxRepo.save(claimed[0]!);
        throw new Error("publisher crashed before commit");
      }),
    ).rejects.toThrow("publisher crashed before commit");

    const claimed = await ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(0), 10));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.isPending()).toBe(true);
  });

  it("should roll back the enqueue together with the surrounding transaction", async () => {
    await expect(
      ctx.unitOfWork.run(async () => {
        await ctx.outboxRepo.enqueue(message(1, at(0)));
        throw new Error("financial failure");
      }),
    ).rejects.toThrow("financial failure");

    expect(await countOutbox()).toBe(0);
  });

  it("should require an active transaction", async () => {
    await expect(ctx.outboxRepo.claimDue(at(0), 1)).rejects.toThrow(/UnitOfWork/);
    await expect(ctx.outboxRepo.enqueue(message(1, at(0)))).rejects.toThrow(/UnitOfWork/);
  });

  it("should reject an invalid claim limit", async () => {
    await expect(ctx.unitOfWork.run(() => ctx.outboxRepo.claimDue(at(0), 0))).rejects.toThrow(
      RangeError,
    );
  });
});

describe("InboxRepository", () => {
  const newInbox = (messageId = "msg-123", consumerName = "wager-transactions") =>
    InboxMessage.receive({
      messageId,
      consumerName,
      payloadHash: "a".repeat(64),
      receivedAt: BASE,
    });

  it("should return false for a duplicate (consumerName, messageId)", async () => {
    const first = await ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox()));
    const duplicate = await ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox()));

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
  });

  it("should scope deduplication by consumer", async () => {
    await ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox("msg-1", "consumer-a")));

    const other = await ctx.unitOfWork.run(() =>
      ctx.inboxRepo.tryReceive(newInbox("msg-1", "consumer-b")),
    );

    expect(other).toBe(true);
  });

  it("should accept exactly one of many simultaneous receptions of the same message", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox("msg-race"))),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("should find and mark a message as processed", async () => {
    await ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox()));

    await ctx.unitOfWork.run(async () => {
      const found = await ctx.inboxRepo.find("wager-transactions", "msg-123");
      expect(found!.isProcessed()).toBe(false);
      expect(found!.payloadHash).toBe("a".repeat(64));
      found!.markProcessed(at(2));
      await ctx.inboxRepo.markProcessed(found!);
    });

    const reloaded = await ctx.unitOfWork.run(() =>
      ctx.inboxRepo.find("wager-transactions", "msg-123"),
    );
    expect(reloaded!.isProcessed()).toBe(true);
    expect(reloaded!.processedAt).toEqual(at(2));
    expect(reloaded!.receivedAt).toEqual(BASE);
  });

  it("should return null for an unknown message", async () => {
    expect(await ctx.unitOfWork.run(() => ctx.inboxRepo.find("c", "missing"))).toBeNull();
  });

  it("should roll the reception back with the surrounding transaction so redelivery reprocesses", async () => {
    await expect(
      ctx.unitOfWork.run(async () => {
        await ctx.inboxRepo.tryReceive(newInbox("msg-retry"));
        throw new Error("processing failed");
      }),
    ).rejects.toThrow("processing failed");

    const redelivery = await ctx.unitOfWork.run(() => ctx.inboxRepo.tryReceive(newInbox("msg-retry")));
    expect(redelivery).toBe(true);
  });
});
