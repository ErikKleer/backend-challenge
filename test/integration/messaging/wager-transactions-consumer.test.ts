import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";
import { waitFor } from "../../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { buildConsumerRig, sendWagerMessage, type ConsumerRig } from "../../support/consumer";
import { createTestQueues, isQueueEmpty, type TestQueues } from "../../support/sqs";
import { brl } from "../../support/wagering";

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
});
