import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SubmitWagerTransactionCommand } from "../../src/wagering/application/submit-wager-transaction.command";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction-types";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { sendWagerMessage } from "../support/consumer";
import { assertAllWalletsConsistent, assertNoStuckTransactions } from "../support/invariants";
import { runInParallel, waitFor } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { AppInstance, postUntilSettled, postWagerTransaction } from "../support/process";
import { createTestQueues, eventIdsOf, isQueueEmpty, receiveUntil, type TestQueues } from "../support/sqs";
import { brl, WageringHarness, type WalletFixture } from "../support/wagering";

const WALLETS = 8;
const HTTP_BETS = 20;
const SQS_BETS = 10;
const OPENING_BALANCE = "500.00";
const AMOUNT = "5.00";
const PROVIDER = "provider-restart";
// Cada wallet: (20 HTTP + 10 SQS + 1 aposta do par) x 5.00 de débito, menos o REFUND de 5.00
const BETS_PER_WALLET = HTTP_BETS + SQS_BETS + 1;
const FINAL_BALANCE = "350.00";
const KILL_AFTER_COMMITTED = 30;

interface WalletPlan {
  wallet: WalletFixture;
  httpBets: SubmitWagerTransactionCommand[];
  sqsBets: SubmitWagerTransactionCommand[];
  /** Aposta que só é enviada depois do reinício; o REFUND dela chega antes, por SQS. */
  pairBet: SubmitWagerTransactionCommand;
  refund: SubmitWagerTransactionCommand;
}

describe("service restart under load", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;
  let queues: TestQueues;
  const started: AppInstance[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
    queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
  });

  afterAll(async () => {
    await Promise.all(started.map((instance) => instance.stop()));
    await queues.teardown();
    await ctx.app.close();
    await db.teardown();
  });

  async function scalar(sql: string, params: unknown[] = []): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ value: string }>>(sql, params);
    return row!.value;
  }

  const committedTransactions = async (): Promise<number> =>
    Number(await scalar("SELECT COUNT(*)::text AS value FROM wager_transactions WHERE kind <> 'OPENING'"));

  async function plan(): Promise<WalletPlan[]> {
    const plans: WalletPlan[] = [];
    for (let n = 0; n < WALLETS; n += 1) {
      const wallet = await harness.createWallet(OPENING_BALANCE);
      const bet = () => harness.command(wallet, { providerId: PROVIDER, money: brl(AMOUNT) });
      const pairBet = bet();
      plans.push({
        wallet,
        httpBets: Array.from({ length: HTTP_BETS }, bet),
        sqsBets: Array.from({ length: SQS_BETS }, bet),
        pairBet,
        refund: harness.command(wallet, {
          providerId: PROVIDER,
          kind: WagerTransactionKind.Refund,
          money: brl(AMOUNT),
          referenceExternalTransactionId: pairBet.externalTransactionId,
        }),
      });
    }
    return plans;
  }

  it("keeps ledger, inbox, outbox and idempotency consistent after SIGKILL and a fresh instance", async () => {
    const plans = await plan();
    const bootOptions = {
      db,
      queues,
      roles: { sqsConsumer: true, outboxPublisher: true, pendingWorker: true },
      // O REFUND que antecede a aposta precisa sobreviver pendente ao reinício
      env: {
        PENDING_REFERENCE_BASE_DELAY_MS: "300",
        PENDING_REFERENCE_MAX_DELAY_MS: "1000",
        PENDING_REFERENCE_MAX_ATTEMPTS: "60",
        OUTBOX_BATCH_SIZE: "5",
      },
    };
    const first = await AppInstance.start({ ...bootOptions, name: "before-restart" });
    started.push(first);

    // ---- carga: SQS (REFUND antes da sua aposta, depois as apostas) e HTTP, tudo em paralelo
    const sqsLoad = Promise.all(
      plans.map(async (entry, walletIndex) => {
        await sendWagerMessage(queues, entry.wallet, entry.refund, `refund-${walletIndex}`);
        for (const [index, bet] of entry.sqsBets.entries()) {
          await sendWagerMessage(queues, entry.wallet, bet, `bet-${walletIndex}-${index}`);
        }
      }),
    );
    const httpCommands = plans.flatMap((entry) => entry.httpBets);
    const httpLoad = runInParallel(httpCommands.length, async (index) => {
      try {
        const outcome = await postWagerTransaction(first.baseUrl, httpCommands[index]!);
        return outcome.status < 500 ? outcome : undefined;
      } catch {
        return undefined; // conexão derrubada pela morte do processo: resultado desconhecido
      }
    });

    // ---- a instância cai com trabalho em andamento (sem handler, sem flush, sem ack)
    await waitFor(async () => (await committedTransactions()) >= KILL_AFTER_COMMITTED, {
      timeoutMs: 60_000,
      intervalMs: 5,
      description: "some transactions to be committed before the kill",
    });
    await first.kill("SIGKILL");
    const committedAtKill = await committedTransactions();
    const totalTransactions = WALLETS * (BETS_PER_WALLET + 1);
    expect(committedAtKill).toBeLessThan(totalTransactions - WALLETS); // pares e a cauda da carga seguem pendentes

    const httpOutcomes = await httpLoad;
    await sqsLoad;

    // ---- reinício: outra instância sobe sobre o mesmo banco e as mesmas filas
    const second = await AppInstance.start({ ...bootOptions, name: "after-restart" });
    started.push(second);

    // O cliente repete, com a mesma chave, o que ficou sem resposta, e só agora envia as apostas dos pares
    const unknown = httpCommands.filter((_command, index) => httpOutcomes[index] === undefined);
    const retried = await runInParallel(unknown.length + plans.length, (index) =>
      postUntilSettled(
        second.baseUrl,
        index < unknown.length ? unknown[index]! : plans[index - unknown.length]!.pairBet,
      ),
    );
    for (const { outcome } of retried) {
      expect([200, 201, 202]).toContain(outcome.status);
    }

    // ---- quiescência: tudo decidido, fila de entrada vazia, outbox publicada
    await waitFor(
      async () =>
        Number(
          await scalar(
            `SELECT COUNT(*)::text AS value FROM wager_transactions
              WHERE kind <> 'OPENING' AND status = 'PROCESSED'`,
          ),
        ) === totalTransactions && (await isQueueEmpty(queues.client, queues.transactionsUrl)),
      { timeoutMs: 120_000, description: "every transaction to be processed and the input queue to drain" },
    );
    await waitFor(
      async () =>
        Number(await scalar("SELECT COUNT(*)::text AS value FROM outbox_messages WHERE published_at IS NULL")) === 0,
      { timeoutMs: 60_000, description: "the restarted instance to publish the whole outbox" },
    );

    // ---- consistência final
    // 1. saldo == soma do ledger em todas as wallets, versões sem lacuna
    expect(await assertAllWalletsConsistent(db.orm.em)).toBe(WALLETS);
    await assertNoStuckTransactions(db.orm.em);
    expect(
      await scalar(
        "SELECT COUNT(*)::text AS value FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')",
      ),
    ).toBe("0");

    // 2. nenhuma duplicação de efeito: débitos, créditos e saldo exatos em cada wallet
    for (const { wallet } of plans) {
      const [shape] = await db.orm.em.execute<Array<{ debits: string; credits: string; balance: string }>>(
        `SELECT COUNT(*) FILTER (WHERE l.direction = 'DEBIT')::text AS debits,
                COUNT(*) FILTER (WHERE l.direction = 'CREDIT')::text AS credits,
                w.balance::text AS balance
           FROM wallets w JOIN wallet_ledger_entries l ON l.wallet_id = w.id
          WHERE w.id = ? GROUP BY w.balance`,
        [wallet.walletId],
      );
      // créditos: abertura + REFUND
      expect(shape).toEqual({ debits: String(BETS_PER_WALLET), credits: "2", balance: FINAL_BALANCE });
    }
    expect(
      await scalar(
        "SELECT COUNT(*)::text AS value FROM inbox_messages WHERE processed_at IS NOT NULL",
      ),
    ).toBe(String(WALLETS * (SQS_BETS + 1)));

    // 3. todo evento publicado uma única vez no banco e ao menos uma vez na fila
    const events = await db.orm.em.execute<Array<{ id: string }>>("SELECT id FROM outbox_messages");
    const received = await receiveUntil(
      queues.client,
      queues.eventsUrl,
      (messages) => new Set(eventIdsOf(messages)).size >= events.length,
      60_000,
    );
    expect(new Set(eventIdsOf(received))).toEqual(new Set(events.map((event) => event.id)));

    // 4. a mesma chave depois do reinício é replay do resultado original
    const sample = httpCommands.filter((_command, index) => httpOutcomes[index] !== undefined).slice(0, 10);
    expect(sample.length).toBeGreaterThan(0);
    for (const command of sample) {
      const original = httpOutcomes[httpCommands.indexOf(command)]!;
      const replay = await postUntilSettled(second.baseUrl, command);
      expect(replay.outcome.status).toBe(200);
      expect(replay.outcome.body.idempotentReplay).toBe(true);
      expect(replay.outcome.body.transactionId).toBe(original.body.transactionId);
    }
    expect(await assertAllWalletsConsistent(db.orm.em)).toBe(WALLETS);
  });
});
