import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { sendWagerMessage } from "../support/consumer";
import { assertAllWalletsConsistent, assertNoStuckTransactions } from "../support/invariants";
import { runInParallel, waitFor } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import {
  type AppInstance,
  type HttpOutcome,
  postWagerTransaction,
  startInstances,
  stopAll,
} from "../support/process";
import { createTestQueues, eventIdsOf, isQueueEmpty, receiveUntil, type TestQueues } from "../support/sqs";
import { brl, WageringHarness } from "../support/wagering";

const INSTANCES = 3;
const ROUNDS = 3;
// 60 apostas de 3.00 sobre 100.00: o número de aprovadas independe da ordem (33 x 3.00 = 99.00)
const BET_AMOUNT = "3.00";
const HTTP_BETS = 40;
const SQS_BETS = 20;
const EXPECTED_PROCESSED = 33;
const MAX_TRANSIENT_RETRIES = 40;

describe("three application instances competing for the same wallet", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;
  let queues: TestQueues;
  let instances: AppInstance[];

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
    queues = await createTestQueues();
    instances = await startInstances(INSTANCES, {
      db,
      queues,
      roles: { sqsConsumer: true, outboxPublisher: true, pendingWorker: true },
    });
  });

  afterAll(async () => {
    await stopAll(instances);
    await queues.teardown();
    await ctx.app.close();
    await db.teardown();
  });

  /** 503 é o contrato para falha transitória (lock timeout): o cliente repete com a mesma chave. */
  async function submitUntilSettled(
    instance: AppInstance,
    command: ReturnType<WageringHarness["command"]>,
  ): Promise<{ outcome: HttpOutcome; transientRetries: number }> {
    let transientRetries = 0;
    for (;;) {
      const outcome = await postWagerTransaction(instance.baseUrl, command);
      if (outcome.status !== 503) {
        return { outcome, transientRetries };
      }
      transientRetries += 1;
      if (transientRetries > MAX_TRANSIENT_RETRIES) {
        throw new Error(`transaction ${command.externalTransactionId} kept failing transiently`);
      }
    }
  }

  async function scalar(sql: string, params: unknown[] = []): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ value: string }>>(sql, params);
    return row!.value;
  }

  for (let round = 1; round <= ROUNDS; round += 1) {
    it(`round ${round}: HTTP and SQS bets across all instances never overspend or double-debit`, async () => {
      const wallet = await harness.createWallet("100.00");
      const httpBets = Array.from({ length: HTTP_BETS }, () =>
        harness.command(wallet, { money: brl(BET_AMOUNT), providerId: "provider-http" }),
      );
      const sqsBets = Array.from({ length: SQS_BETS }, () =>
        harness.command(wallet, { money: brl(BET_AMOUNT), providerId: "provider-sqs" }),
      );

      // HTTP (espalhado entre as instâncias) e SQS (consumido por todas) disparam juntos
      const [httpResults] = await Promise.all([
        runInParallel(HTTP_BETS, (index) =>
          submitUntilSettled(instances[index % INSTANCES]!, httpBets[index]!),
        ),
        (async () => {
          for (const [index, bet] of sqsBets.entries()) {
            await sendWagerMessage(queues, wallet, bet, `msg-${round}-${index}`);
            // Redelivery do mesmo messageId em algumas: a inbox precisa descartá-las
            if (index % 4 === 0) {
              await sendWagerMessage(queues, wallet, bet, `msg-${round}-${index}`, {
                deduplicationId: `redelivery-${round}-${index}`,
              });
            }
          }
        })(),
      ]);

      // Quiescência: todas as apostas decididas, fila de entrada vazia, outbox publicada
      await waitFor(
        async () =>
          Number(
            await scalar(
              `SELECT COUNT(*)::text AS value FROM wager_transactions
                WHERE wallet_id = ? AND kind <> 'OPENING' AND status IN ('PROCESSED', 'REJECTED')`,
              [wallet.walletId],
            ),
          ) ===
            HTTP_BETS + SQS_BETS && (await isQueueEmpty(queues.client, queues.transactionsUrl)),
        { timeoutMs: 90_000, description: "every bet to be decided and the input queue to drain" },
      );
      await waitFor(
        async () =>
          Number(await scalar("SELECT COUNT(*)::text AS value FROM outbox_messages WHERE published_at IS NULL")) ===
          0,
        { timeoutMs: 30_000, description: "the outbox to be fully published" },
      );

      const processed = Number(
        await scalar(
          `SELECT COUNT(*)::text AS value FROM wager_transactions
            WHERE wallet_id = ? AND kind <> 'OPENING' AND status = 'PROCESSED'`,
          [wallet.walletId],
        ),
      );
      const rejected = Number(
        await scalar(
          `SELECT COUNT(*)::text AS value FROM wager_transactions
            WHERE wallet_id = ? AND kind <> 'OPENING' AND status = 'REJECTED'
              AND failure_code = 'INSUFFICIENT_FUNDS'`,
          [wallet.walletId],
        ),
      );
      expect(processed).toBe(EXPECTED_PROCESSED);
      expect(rejected).toBe(HTTP_BETS + SQS_BETS - EXPECTED_PROCESSED);
      expect(await scalar("SELECT balance::text AS value FROM wallets WHERE id = ?", [wallet.walletId])).toBe("1.00");

      // Um lançamento de débito por aposta aprovada (mais o crédito de abertura): nada duplicado
      const [shape] = await db.orm.em.execute<Array<{ debits: string; credits: string; distinct_tx: string }>>(
        `SELECT COUNT(*) FILTER (WHERE direction = 'DEBIT')::text AS debits,
                COUNT(*) FILTER (WHERE direction = 'CREDIT')::text AS credits,
                COUNT(DISTINCT transaction_id)::text AS distinct_tx
           FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [wallet.walletId],
      );
      expect(shape).toEqual({ debits: String(EXPECTED_PROCESSED), credits: "1", distinct_tx: String(EXPECTED_PROCESSED + 1) });

      // HTTP: cada status coerente com o resultado; nenhuma aposta ficou sem resposta definitiva
      const httpStatuses = httpResults.map(({ outcome }) => outcome.body.status);
      expect(httpStatuses.every((status) => status === "PROCESSED" || status === "REJECTED")).toBe(true);

      // A prova de que foi multiprocesso: cada instância atendeu apostas HTTP
      for (const instance of instances) {
        await waitFor(
          () =>
            instance
              .logs()
              .some((entry) => entry.msg === "wager transaction submitted" && entry.source === "http"),
          { description: `instance '${instance.name}' to have served HTTP bets` },
        );
      }

      // Eventos: todo evento da wallet chegou à fila pelo menos uma vez
      const outboxIds = (
        await db.orm.em.execute<Array<{ id: string }>>("SELECT id FROM outbox_messages WHERE aggregate_id = ?", [
          wallet.walletId,
        ])
      ).map((row) => row.id);
      const received = await receiveUntil(queues.client, queues.eventsUrl, (messages) =>
        outboxIds.every((id) => eventIdsOf(messages).includes(id)),
      );
      expect(eventIdsOf(received)).toEqual(expect.arrayContaining(outboxIds));

      await assertNoStuckTransactions(db.orm.em);
      await assertAllWalletsConsistent(db.orm.em);
    });
  }
});
