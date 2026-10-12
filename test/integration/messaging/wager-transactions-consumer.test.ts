import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";
import { waitFor } from "../../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { buildConsumerRig, counterValue, sendWagerMessage, wagerMessageBody, type ConsumerRig } from "../../support/consumer";
import { createTestQueues, isQueueEmpty, receiveUntil, sendMessage, type TestQueues } from "../../support/sqs";
import { brl } from "../../support/wagering";
import type { LedgerRepository } from "../../../src/wallet/application/ledger.repository.port";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry";
import { LockTimeoutError } from "../../../src/shared/infrastructure/persistence/postgres-errors";

let db: TestDatabaseContext;
let ctx: PersistenceTestContext;
let queues: TestQueues;
let rig: ConsumerRig;

beforeAll(async () => {
  db = await createTestDatabase();
  ctx = await createPersistenceTestContext(db);
});

afterAll(async () => {
  await ctx.app.close();
  await db.teardown();
});

beforeEach(async () => {
  queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
  rig = buildConsumerRig(ctx, queues);
});

afterEach(async () => {
  await rig.poller.stop();
  await queues.teardown();
});

async function walletOf(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await db.orm.em.fork().execute<Array<{ balance: string; version: number }>>(
    "SELECT balance::text AS balance, version FROM wallets WHERE id = ?",
    [walletId],
  );
  return row!;
}

/** Inbox das mensagens do teste (o banco é compartilhado pela suíte, então filtra pelo sufixo). */
async function inboxRows(suffix: string): Promise<Array<{ messageId: string; processed: boolean }>> {
  return db.orm.em.fork().execute(
    `SELECT message_id AS "messageId", processed_at IS NOT NULL AS processed
       FROM inbox_messages WHERE message_id LIKE ? ORDER BY message_id`,
    [`%${suffix}`],
  );
}

/** Ids de mensagem únicos por teste: `msg-a-<sufixo>`. */
function messageIds(...names: string[]): { suffix: string; ids: string[] } {
  const suffix = `-${randomBytes(4).toString("hex")}`;
  return { suffix, ids: names.map((name) => `${name}${suffix}`) };
}

async function transactionCount(walletId: string): Promise<number> {
  const [row] = await db.orm.em.fork().execute<Array<{ n: string }>>(
    "SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
    [walletId],
  );
  return Number(row!.n);
}

async function outboxEventTypes(walletId: string): Promise<string[]> {
  const rows = await db.orm.em.fork().execute<Array<{ eventType: string }>>(
    `SELECT event_type AS "eventType" FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`,
    [walletId],
  );
  return rows.map((row) => row.eventType);
}

async function transactionsOf(walletId: string): Promise<Array<{ status: string; failureCode: string | null }>> {
  return db.orm.em.fork().execute(
    `SELECT status, failure_code AS "failureCode" FROM wager_transactions
      WHERE wallet_id = ? AND kind <> 'OPENING'`,
    [walletId],
  );
}

const queueDrained = () =>
  waitFor(() => isQueueEmpty(queues.client, queues.transactionsUrl), {
    timeoutMs: 20_000,
    description: "transactions queue drained",
  });

describe("wager transactions consumer", () => {
  it("processes a message once: financial effect, inbox row, outbox events and an empty queue", async () => {
    const wallet = await rig.harness.createWallet("100.00");
    const command = rig.harness.command(wallet, { money: brl("30.00") });
    const { suffix, ids } = messageIds("msg-once");

    await sendWagerMessage(queues, wallet, command, ids[0]!);
    rig.poller.start();
    await queueDrained();
    await rig.poller.stop();

    expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
    expect(await transactionCount(wallet.walletId)).toBe(1);
    expect(await inboxRows(suffix)).toEqual([{ messageId: ids[0]!, processed: true }]);
    expect(await outboxEventTypes(wallet.walletId)).toContain("WagerTransactionProcessed");
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
  });

  it("applies one effect when the same messageId is delivered twice, acknowledging both", async () => {
    const wallet = await rig.harness.createWallet("100.00");
    const command = rig.harness.command(wallet, { money: brl("30.00") });

    const { suffix, ids } = messageIds("msg-twice");

    // Deduplication ids distintos: o FIFO entrega as duas cópias, como num redelivery do broker
    await sendWagerMessage(queues, wallet, command, ids[0]!, { deduplicationId: "copy-1" });
    await sendWagerMessage(queues, wallet, command, ids[0]!, { deduplicationId: "copy-2" });
    rig.poller.start();
    await queueDrained();
    await rig.poller.stop();

    expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
    expect(await transactionCount(wallet.walletId)).toBe(1);
    expect(await inboxRows(suffix)).toEqual([{ messageId: ids[0]!, processed: true }]);
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
  });

  it("treats another messageId with the same idempotencyKey and payload as a replay", async () => {
    const wallet = await rig.harness.createWallet("100.00");
    const command = rig.harness.command(wallet, { money: brl("30.00") });

    const { suffix, ids } = messageIds("msg-a", "msg-b");

    await sendWagerMessage(queues, wallet, command, ids[0]!);
    await sendWagerMessage(queues, wallet, command, ids[1]!);
    rig.poller.start();
    await queueDrained();
    await rig.poller.stop();

    expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
    expect(await transactionCount(wallet.walletId)).toBe(1);
    expect(await inboxRows(suffix)).toEqual([
      { messageId: ids[0]!, processed: true },
      { messageId: ids[1]!, processed: true },
    ]);
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
  });

  describe("business outcomes", () => {
    it("persists a rejection, acknowledges the message and leaves the DLQ empty", async () => {
      const wallet = await rig.harness.createWallet("100.00");
      const command = rig.harness.command(wallet, { money: brl("500.00") });

      await sendWagerMessage(queues, wallet, command, messageIds("msg-reject").ids[0]!);
      rig.poller.start();
      await queueDrained();
      await rig.poller.stop();

      expect(await transactionsOf(wallet.walletId)).toEqual([
        { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" },
      ]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
      expect(await isQueueEmpty(queues.client, queues.dlqUrl)).toBe(true);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
    });

    it("acknowledges an idempotency conflict without touching the first result", async () => {
      const wallet = await rig.harness.createWallet("100.00");
      const first = rig.harness.command(wallet, { money: brl("30.00") });
      const conflicting = { ...first, money: brl("40.00") };
      const { suffix, ids } = messageIds("msg-first", "msg-conflict");

      await sendWagerMessage(queues, wallet, first, ids[0]!);
      await sendWagerMessage(queues, wallet, conflicting, ids[1]!);
      rig.poller.start();
      await queueDrained();
      await rig.poller.stop();

      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
      expect(await transactionCount(wallet.walletId)).toBe(1);
      // A transação do conflito desfez a inbox junto: só a primeira mensagem ficou registrada
      expect(await inboxRows(suffix)).toEqual([{ messageId: ids[0]!, processed: true }]);
      expect(await isQueueEmpty(queues.client, queues.dlqUrl)).toBe(true);
      expect(await counterValue(rig.metrics, "wager_duplicates_total", { type: "conflict" })).toBe(1);
    });
  });

  describe("transient failures", () => {
    it("redelivers after the backoff and finishes processed, with a single effect", async () => {
      let failuresLeft = 2;
      const failingLedger = (real: LedgerRepository): LedgerRepository => ({
        findPage: (...args) => real.findPage(...args),
        append: async (entry: WalletLedgerEntry) => {
          await real.append(entry);
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            // Depois do lançamento real: o rollback precisa desfazer saldo, ledger e inbox juntos
            throw new LockTimeoutError();
          }
        },
      });
      rig = buildConsumerRig(ctx, queues, { overrides: { ledger: failingLedger(ctx.ledgerRepo) } });
      const wallet = await rig.harness.createWallet("100.00");
      const command = rig.harness.command(wallet, { money: brl("30.00") });
      const { suffix, ids } = messageIds("msg-flaky");

      await sendWagerMessage(queues, wallet, command, ids[0]!);
      rig.poller.start();
      await queueDrained();
      await rig.poller.stop();

      expect(failuresLeft).toBe(0);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
      expect(await transactionCount(wallet.walletId)).toBe(1);
      expect(await inboxRows(suffix)).toEqual([{ messageId: ids[0]!, processed: true }]);
      expect(await counterValue(rig.metrics, "wager_retries_total", { reason: "transient_failure" })).toBe(2);
      expect(await counterValue(rig.metrics, "wager_retries_total", { reason: "redelivery" })).toBe(2);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
    });
  });

  describe("permanent failures", () => {
    /** Aguarda a principal esvaziar e devolve o que chegou à DLQ (apagando-o, como o helper faz). */
    async function drainToDlq(expected: number) {
      rig.poller.start();
      await queueDrained();
      await rig.poller.stop();
      return receiveUntil(queues.client, queues.dlqUrl, (all) => all.length >= expected, 10_000);
    }

    it("moves invalid JSON to the DLQ with the same group and empties the main queue", async () => {
      await sendMessage(queues.client, queues.transactionsUrl, "{not json", { groupId: "group-bad" });

      const inDlq = await drainToDlq(1);

      expect(inDlq).toHaveLength(1);
      expect(inDlq[0]?.body).toBe("{not json");
      expect(inDlq[0]?.groupId).toBe("group-bad");
      expect(await isQueueEmpty(queues.client, queues.transactionsUrl)).toBe(true);
      expect(await counterValue(rig.metrics, "sqs_dlq_messages_total", { reason: "invalid_message" })).toBe(1);
    });

    it("moves an unknown type, a schema violation and an OPENING request to the DLQ", async () => {
      const wallet = await rig.harness.createWallet("100.00");
      const command = rig.harness.command(wallet);
      const base = JSON.parse(wagerMessageBody(command, "msg-base"));
      const bodies = [
        JSON.stringify({ ...base, type: "SomethingElse" }),
        JSON.stringify({ ...base, data: { ...base.data, money: { amount: "10.5", currency: "BRL" } } }),
        JSON.stringify({ ...base, data: { ...base.data, kind: "OPENING" } }),
      ];
      for (const body of bodies) {
        await sendMessage(queues.client, queues.transactionsUrl, body, { groupId: wallet.walletId });
      }

      const inDlq = await drainToDlq(3);

      expect(inDlq.map((message) => message.body).sort()).toEqual([...bodies].sort());
      expect(await transactionCount(wallet.walletId)).toBe(0);
      expect(await counterValue(rig.metrics, "sqs_dlq_messages_total", { reason: "invalid_message" })).toBe(3);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
    });

    it("moves a request for a wallet that does not exist to the DLQ", async () => {
      const ghost = { walletId: randomUUID(), playerId: "player-ghost" };
      const command = rig.harness.command(ghost);

      await sendWagerMessage(queues, ghost, command, messageIds("msg-ghost").ids[0]!);
      const inDlq = await drainToDlq(1);

      expect(inDlq).toHaveLength(1);
      expect(await counterValue(rig.metrics, "sqs_dlq_messages_total", { reason: "permanent_failure" })).toBe(1);
    });

    it("moves a messageId reused with a different payload to the DLQ and keeps the first effect", async () => {
      const wallet = await rig.harness.createWallet("100.00");
      const first = rig.harness.command(wallet, { money: brl("30.00") });
      const tampered = { ...first, money: brl("90.00") };
      const { suffix, ids } = messageIds("msg-reused");

      await sendWagerMessage(queues, wallet, first, ids[0]!);
      // Mesmo messageId, conteúdo diferente: não é redelivery
      await sendWagerMessage(queues, wallet, tampered, ids[0]!);
      const inDlq = await drainToDlq(1);

      expect(inDlq).toHaveLength(1);
      expect(JSON.parse(inDlq[0]!.body).data.money.amount).toBe("90.00");
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
      expect(await inboxRows(suffix)).toEqual([{ messageId: ids[0]!, processed: true }]);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
    });

    it("keeps the message when the DLQ send fails and delivers it to the DLQ once it recovers", async () => {
      let failuresLeft = 1;
      rig = buildConsumerRig(ctx, queues, {
        deadLetters: (real) => ({
          send: async (message, info) => {
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error("injected DLQ failure");
            }
            await real.send(message, info);
          },
        }),
      });
      await sendMessage(queues.client, queues.transactionsUrl, "not even json", { groupId: "group-dlq-down" });

      const inDlq = await drainToDlq(1);

      expect(failuresLeft).toBe(0);
      expect(inDlq).toHaveLength(1);
      expect(await counterValue(rig.metrics, "sqs_dlq_messages_total", { reason: "invalid_message" })).toBe(1);
      expect(await counterValue(rig.metrics, "wager_retries_total", { reason: "transient_failure" })).toBe(1);
    });
  });

  describe("exhausted retries", () => {
    it("lets the redrive policy move a message that keeps failing transiently to the DLQ", async () => {
      const limited = await createTestQueues({ visibilityTimeoutSeconds: 3, maxReceiveCount: 2 });
      try {
        let attempts = 0;
        const alwaysFailing: LedgerRepository = {
          findPage: (...args) => ctx.ledgerRepo.findPage(...args),
          append: async (entry: WalletLedgerEntry) => {
            await ctx.ledgerRepo.append(entry);
            attempts += 1;
            throw new LockTimeoutError();
          },
        };
        const limitedRig = buildConsumerRig(ctx, limited, { overrides: { ledger: alwaysFailing } });
        const wallet = await limitedRig.harness.createWallet("100.00");
        const command = limitedRig.harness.command(wallet, { money: brl("30.00") });
        const { suffix, ids } = messageIds("msg-doomed");

        await sendWagerMessage(limited, wallet, command, ids[0]!);
        limitedRig.poller.start();
        await waitFor(() => isQueueEmpty(limited.client, limited.transactionsUrl), {
          timeoutMs: 30_000,
          description: "main queue drained by the redrive policy",
        });
        await limitedRig.poller.stop();
        const inDlq = await receiveUntil(limited.client, limited.dlqUrl, (all) => all.length >= 1, 10_000);

        expect(attempts).toBe(2);
        expect(inDlq).toHaveLength(1);
        expect(JSON.parse(inDlq[0]!.body).messageId).toBe(ids[0]!);
        // Cada tentativa foi desfeita por inteiro: nada de saldo, transação ou inbox
        expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
        expect(await transactionCount(wallet.walletId)).toBe(0);
        expect(await inboxRows(suffix)).toEqual([]);
        expect(await counterValue(limitedRig.metrics, "sqs_dlq_messages_total", { reason: "max_receive_count" })).toBe(1);
        await assertLedgerMatchesBalance(wallet.walletId, db.orm.em.fork());
      } finally {
        await limited.teardown();
      }
    });
  });
});
