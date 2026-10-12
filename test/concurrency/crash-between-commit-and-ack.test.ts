import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { sendWagerMessage } from "../support/consumer";
import { assertAllWalletsConsistent, assertNoStuckTransactions } from "../support/invariants";
import { waitFor } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { AppInstance, startInstances, stopAll } from "../support/process";
import { createTestQueues, isQueueEmpty, type TestQueues } from "../support/sqs";
import { brl, WageringHarness, type WalletFixture } from "../support/wagering";

const WALLETS = 6;
const INBOX_CONSUMER = "wager-transactions-consumer";

describe("worker killed after the commit and before the acknowledgement", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;
  let queues: TestQueues;
  const started: AppInstance[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
    // Visibilidade curta: a mensagem não confirmada volta logo para outra instância
    queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
  });

  afterAll(async () => {
    await stopAll(started);
    await queues.teardown();
    await ctx.app.close();
    await db.teardown();
  });

  async function scalar(sql: string, params: unknown[] = []): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ value: string }>>(sql, params);
    return row!.value;
  }

  it("lets other instances take the redelivery, discard it through the inbox and keep a single effect", async () => {
    const wallets: WalletFixture[] = [];
    for (let n = 0; n < WALLETS; n += 1) {
      wallets.push(await harness.createWallet("100.00"));
    }
    const commands = wallets.map((wallet) => harness.command(wallet, { money: brl("30.00") }));

    // A única instância viva consome primeiro e é morta (SIGKILL) ao alcançar o ponto de falha
    const doomed = await AppInstance.start({
      name: "doomed",
      db,
      queues,
      roles: { sqsConsumer: true },
      env: { FAULT_INJECTION: "after_commit_before_ack=crash" },
    });
    started.push(doomed);

    for (const [index, wallet] of wallets.entries()) {
      await sendWagerMessage(queues, wallet, commands[index]!, `msg-crash-${index}`);
    }
    await doomed.waitForExit();

    // O que ela deixou: pelo menos um efeito já commitado cuja mensagem segue na fila
    const committedBeforeTakeover = Number(
      await scalar("SELECT COUNT(*)::text AS value FROM wager_transactions WHERE kind <> 'OPENING' AND status = 'PROCESSED'"),
    );
    expect(committedBeforeTakeover).toBeGreaterThanOrEqual(1);
    expect(await isQueueEmpty(queues.client, queues.transactionsUrl)).toBe(false);

    // Duas outras instâncias assumem e esvaziam a fila
    const takeovers = await startInstances(2, { db, queues, roles: { sqsConsumer: true } });
    started.push(...takeovers);

    await waitFor(
      async () =>
        Number(
          await scalar(
            "SELECT COUNT(*)::text AS value FROM wager_transactions WHERE kind <> 'OPENING' AND status = 'PROCESSED'",
          ),
        ) === WALLETS && (await isQueueEmpty(queues.client, queues.transactionsUrl)),
      { timeoutMs: 60_000, description: "the takeover instances to settle every message and drain the queue" },
    );

    // Uma transação, um débito e uma linha de inbox processada por mensagem, nunca duas
    expect(await scalar("SELECT COUNT(*)::text AS value FROM wager_transactions WHERE kind <> 'OPENING'")).toBe(
      String(WALLETS),
    );
    expect(
      await scalar("SELECT COUNT(*)::text AS value FROM wallet_ledger_entries WHERE direction = 'DEBIT'"),
    ).toBe(String(WALLETS));
    expect(
      await scalar(
        "SELECT COUNT(*)::text AS value FROM inbox_messages WHERE consumer_name = ? AND processed_at IS NOT NULL",
        [INBOX_CONSUMER],
      ),
    ).toBe(String(WALLETS));
    for (const wallet of wallets) {
      expect(await scalar("SELECT balance::text AS value FROM wallets WHERE id = ?", [wallet.walletId])).toBe("70.00");
    }

    // O efeito commitado pela instância morta voltou como replay e foi descartado, não reaplicado
    const replays = () =>
      takeovers
        .flatMap((instance) => instance.logs())
        .filter((entry) => entry.msg === "wager transaction submitted" && entry.idempotentReplay === true);
    await waitFor(() => replays().length >= 1, { description: "the replay log of the redelivered message" });

    await assertNoStuckTransactions(db.orm.em);
    expect(await assertAllWalletsConsistent(db.orm.em)).toBe(WALLETS);
  });
});
