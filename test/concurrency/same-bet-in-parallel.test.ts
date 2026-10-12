import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction-types";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { startTestApi, type TestApi } from "../support/http-app";
import { assertWalletInvariants } from "../support/invariants";
import { runInParallel } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { WageringHarness } from "../support/wagering";

const PARALLELISM = 50;
const POOL_MAX = 30;

interface HttpResult {
  status: number;
  body: {
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
}

describe("same bet submitted 50x in parallel", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;
  let api: TestApi;

  beforeAll(async () => {
    db = await createTestDatabase({ poolMax: POOL_MAX });
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
    api = await startTestApi(db);
  });

  afterAll(async () => {
    await api.close();
    await ctx.app.close();
    await db.teardown();
  });

  async function countOf(walletId: string): Promise<{ transactions: number; outbox: number }> {
    const [tx] = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
      [walletId],
    );
    const [outbox] = await db.orm.em.execute<Array<{ n: string }>>(
      `SELECT COUNT(*) AS n FROM outbox_messages
        WHERE aggregate_id = ?`,
      [walletId],
    );
    return { transactions: Number(tx?.n), outbox: Number(outbox?.n) };
  }

  it("yields one transaction, one debit and 49 replays (use case)", async () => {
    const wallet = await harness.createWallet("100.00");
    const bet = harness.command(wallet);
    const outboxBefore = (await countOf(wallet.walletId)).outbox;

    const results = await runInParallel(PARALLELISM, () => harness.useCase.execute(bet));

    const firsts = results.filter((result) => !result.idempotentReplay);
    const replays = results.filter((result) => result.idempotentReplay);
    expect(firsts).toHaveLength(1);
    expect(replays).toHaveLength(PARALLELISM - 1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("90.00");
    }

    const shape = await assertWalletInvariants(wallet.walletId, db.orm.em);
    // OPENING (crédito) + exatamente um débito.
    expect(shape).toEqual({ entries: 2, debits: 1, credits: 1 });
    // A aposta gera exatamente 2 eventos (transação + saldo), não 2 x 50.
    expect(await countOf(wallet.walletId)).toEqual({ transactions: 1, outbox: outboxBefore + 2 });
    const [row] = await db.orm.em.execute<Array<{ balance: string }>>(
      "SELECT balance::text AS balance FROM wallets WHERE id = ?",
      [wallet.walletId],
    );
    expect(row?.balance).toBe("90.00");
  });

  it("yields one transaction, one debit and 49 replays (real HTTP)", async () => {
    const wallet = await harness.createWallet("100.00");
    const outboxBefore = (await countOf(wallet.walletId)).outbox;
    const externalTransactionId = `ext-http-parallel-${wallet.walletId}`;
    const payload = JSON.stringify({
      providerId: "provider-parallel",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });

    const results = await runInParallel(PARALLELISM, async (): Promise<HttpResult> => {
      const response = await fetch(`${api.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `provider-parallel:${externalTransactionId}`,
        },
        body: payload,
      });
      return { status: response.status, body: (await response.json()) as HttpResult["body"] };
    });

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200)).toHaveLength(PARALLELISM - 1);
    expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
    for (const result of results) {
      expect(result.body.status).toBe("PROCESSED");
      expect(result.body.balance).toEqual({ amount: "90.00", currency: "BRL" });
    }

    const shape = await assertWalletInvariants(wallet.walletId, db.orm.em);
    expect(shape).toEqual({ entries: 2, debits: 1, credits: 1 });
    expect(await countOf(wallet.walletId)).toEqual({ transactions: 1, outbox: outboxBefore + 2 });
  });
});
