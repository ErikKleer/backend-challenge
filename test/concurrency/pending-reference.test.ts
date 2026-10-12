import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SubmittableKind } from "../../src/wagering/application/submit-wager-transaction.command";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/wagering/domain/wager-transaction-types";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { assertWalletInvariants } from "../support/invariants";
import { runInParallel, waitFor } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { brl, WageringHarness, type WalletFixture } from "../support/wagering";

const { Bet, Refund, Rollback, Win } = WagerTransactionKind;

const POOL_MAX = 30;

describe("reversals delivered before their reference (PostgreSQL)", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  // Duas instâncias do reprocessador sobre o mesmo banco simulam dois processos worker
  let workerA: WageringHarness;
  let workerB: WageringHarness;

  beforeAll(async () => {
    db = await createTestDatabase({ poolMax: POOL_MAX });
    ctx = await createPersistenceTestContext(db);
    // Backoff curto e tentativas de sobra: os testes provam consistência, não o esgotamento
    const pendingPolicy = { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 200 };
    workerA = new WageringHarness(ctx, { pendingPolicy, reprocessBatchSize: 5 });
    workerB = new WageringHarness(ctx, { pendingPolicy, reprocessBatchSize: 5 });
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  async function countByStatus(status: string): Promise<number> {
    const [row] = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE status = ?",
      [status],
    );
    return Number(row!.n);
  }

  async function ledgerEntriesPerTransaction(walletId: string): Promise<Map<string, number>> {
    const rows = await db.orm.em.execute<Array<{ transaction_id: string; n: string }>>(
      `SELECT transaction_id, COUNT(*)::text AS n FROM wallet_ledger_entries
        WHERE wallet_id = ? GROUP BY transaction_id`,
      [walletId],
    );
    return new Map(rows.map((row) => [row.transaction_id, Number(row.n)]));
  }

  async function balanceOf(walletId: string): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ balance: string }>>(
      "SELECT balance::text AS balance FROM wallets WHERE id = ?",
      [walletId],
    );
    return row!.balance;
  }

  it("two workers over the same pending reversals settle each of them exactly once", async () => {
    const WALLETS = 5;
    const REFUNDS_PER_WALLET = 6;
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => workerA.createWallet("100.00")),
    );

    // Todos os REFUND chegam antes das BET
    const refunds: Array<{ wallet: WalletFixture; externalId: string; transactionId: string }> = [];
    for (const wallet of wallets) {
      for (let n = 0; n < REFUNDS_PER_WALLET; n += 1) {
        const bet = workerA.command(wallet, { kind: Bet });
        const refund = await workerA.useCase.execute(
          workerA.command(wallet, {
            kind: Refund,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );
        expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
        refunds.push({ wallet, externalId: bet.externalTransactionId, transactionId: refund.transactionId });
        // A BET chega depois; ao ser processada acorda o REFUND dependente
        const settled = await workerA.useCase.execute(bet);
        expect(settled.status).toBe(WagerTransactionStatus.Processed);
      }
    }
    expect(await countByStatus("PENDING_REFERENCE")).toBe(WALLETS * REFUNDS_PER_WALLET);

    // Os dois workers disputam as mesmas pendentes, em rodadas simultâneas
    let claimedTotal = 0;
    await waitFor(
      async () => {
        const results = await runInParallel(4, (index) =>
          (index % 2 === 0 ? workerA : workerB).reprocessor.runOnce(),
        );
        claimedTotal += results.reduce((sum, result) => sum + result.claimed, 0);
        return (await countByStatus("PENDING_REFERENCE")) === 0;
      },
      { description: "all pending reversals to be settled", timeoutMs: 30_000 },
    );

    // Cada pendente foi reclamada e liquidada uma única vez
    expect(claimedTotal).toBe(WALLETS * REFUNDS_PER_WALLET);
    expect(await countByStatus("REJECTED")).toBe(0);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.walletId)).toBe("100.00");
      const credits = await ledgerEntriesPerTransaction(wallet.walletId);
      for (const refund of refunds.filter((entry) => entry.wallet === wallet)) {
        expect(credits.get(refund.transactionId)).toBe(1);
      }
      expect(await assertWalletInvariants(wallet.walletId, db.orm.em)).toEqual({
        entries: 1 + 2 * REFUNDS_PER_WALLET,
        debits: REFUNDS_PER_WALLET,
        credits: 1 + REFUNDS_PER_WALLET,
      });
    }
  });

  it("workers running while the references are being submitted never deadlock or double-apply", async () => {
    const REVERSALS = 12;
    const wallet = await workerA.createWallet("500.00");
    const pairs = Array.from({ length: REVERSALS }, (_unused, index) => ({
      // Metade REFUND de BET, metade ROLLBACK de WIN: as duas direções do ledger
      kind: index % 2 === 0 ? (Refund as SubmittableKind) : (Rollback as SubmittableKind),
      referenceKind: index % 2 === 0 ? (Bet as SubmittableKind) : (Win as SubmittableKind),
    }));

    const reversals = await Promise.all(
      pairs.map(async ({ kind, referenceKind }) => {
        const reference = workerA.command(wallet, { kind: referenceKind, money: brl("10.00") });
        const reversal = await workerA.useCase.execute(
          workerA.command(wallet, {
            kind,
            referenceExternalTransactionId: reference.externalTransactionId,
          }),
        );
        expect(reversal.status).toBe(WagerTransactionStatus.PendingReference);
        return { reference, transactionId: reversal.transactionId };
      }),
    );

    // Referências e dois workers em paralelo sobre a mesma wallet
    let submitting = true;
    const worker = async (harness: WageringHarness): Promise<void> => {
      while (submitting || (await countByStatus("PENDING_REFERENCE")) > 0) {
        const { claimed } = await harness.reprocessor.runOnce();
        if (claimed === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
      }
    };
    const workers = [worker(workerA), worker(workerB)];
    const references = await runInParallel(REVERSALS, async (index) => {
      const result = await workerA.useCase.execute(reversals[index]!.reference);
      return result.status;
    });
    submitting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(workers),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("workers did not settle the pending reversals in time")),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    expect(references.every((status) => status === WagerTransactionStatus.Processed)).toBe(true);
    expect(await countByStatus("REJECTED")).toBe(0);
    expect(await countByStatus("PENDING_REFERENCE")).toBe(0);
    // Cada reversão desfez exatamente a sua referência: o saldo volta ao inicial
    expect(await balanceOf(wallet.walletId)).toBe("500.00");
    const credits = await ledgerEntriesPerTransaction(wallet.walletId);
    for (const reversal of reversals) {
      expect(credits.get(reversal.transactionId)).toBe(1);
    }
    expect(await assertWalletInvariants(wallet.walletId, db.orm.em)).toEqual({
      entries: 1 + 2 * REVERSALS,
      debits: REVERSALS,
      credits: 1 + REVERSALS,
    });
  });

  it("a second reversal of the same reference is rejected as ALREADY_REVERSED, never applied twice", async () => {
    const wallet = await workerA.createWallet("100.00");
    const bet = workerA.command(wallet, { kind: Bet });
    const refund = await workerA.useCase.execute(
      workerA.command(wallet, { kind: Refund, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const rollback = await workerA.useCase.execute(
      workerA.command(wallet, { kind: Rollback, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    await workerA.useCase.execute(bet);
    await waitFor(
      async () => {
        await runInParallel(2, (index) => (index === 0 ? workerA : workerB).reprocessor.runOnce());
        return (await countByStatus("PENDING_REFERENCE")) === 0;
      },
      { description: "both reversals to be settled", timeoutMs: 30_000 },
    );

    const statuses = await db.orm.em.execute<Array<{ kind: string; status: string; failure_code: string | null }>>(
      `SELECT kind, status, failure_code FROM wager_transactions
        WHERE id IN (?, ?) ORDER BY kind`,
      [refund.transactionId, rollback.transactionId],
    );
    const processed = statuses.filter((row) => row.status === "PROCESSED");
    const rejected = statuses.filter((row) => row.status === "REJECTED");
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failure_code).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(wallet.walletId)).toBe("100.00");
    expect(await assertWalletInvariants(wallet.walletId, db.orm.em)).toEqual({
      entries: 3,
      debits: 1,
      credits: 2,
    });
  });
});
