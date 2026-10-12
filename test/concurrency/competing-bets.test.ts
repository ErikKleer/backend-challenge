import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  FailureCode,
  WagerTransactionStatus,
} from "../../src/wagering/domain/wager-transaction-types";
import { createTestDatabase, type TestDatabaseContext } from "../support/database";
import { assertWalletInvariants } from "../support/invariants";
import { runInParallel } from "../support/parallel";
import { createPersistenceTestContext, type PersistenceTestContext } from "../support/persistence";
import { brl, WageringHarness } from "../support/wagering";

const POOL_MAX = 30;

describe("competing bets on the same balance", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;

  beforeAll(async () => {
    db = await createTestDatabase({ poolMax: POOL_MAX });
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  async function balanceOf(walletId: string): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ balance: string }>>(
      "SELECT balance::text AS balance FROM wallets WHERE id = ?",
      [walletId],
    );
    return row!.balance;
  }

  describe("mandatory scenario (README section 8)", () => {
    // Saldo 100.00 e duas apostas de 80.00 simultâneas, repetido com wallets novas.
    for (let round = 1; round <= 20; round += 1) {
      it(`round ${round}: one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00, one debit`, async () => {
        const wallet = await harness.createWallet("100.00");
        const first = harness.command(wallet, { money: brl("80.00") });
        const second = harness.command(wallet, { money: brl("80.00") });

        const results = await runInParallel(2, (index) =>
          harness.useCase.execute(index === 0 ? first : second),
        );

        const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
        const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
        expect(processed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(results.every((r) => !r.idempotentReplay)).toBe(true);
        expect(await balanceOf(wallet.walletId)).toBe("20.00");

        // Retry das duas, também em paralelo: tudo vira replay, nada se duplica.
        const retries = await runInParallel(4, (index) =>
          harness.useCase.execute(index % 2 === 0 ? first : second),
        );
        expect(retries.every((r) => r.idempotentReplay)).toBe(true);
        const originalIds = new Set(results.map((r) => r.transactionId));
        expect(retries.every((r) => originalIds.has(r.transactionId))).toBe(true);
        expect(retries.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(2);
        expect(retries.filter((r) => r.status === WagerTransactionStatus.Rejected)).toHaveLength(2);

        const shape = await assertWalletInvariants(wallet.walletId, db.orm.em);
        // Crédito de abertura + exatamente um débito.
        expect(shape).toEqual({ entries: 2, debits: 1, credits: 1 });
        expect(await balanceOf(wallet.walletId)).toBe("20.00");
      });
    }
  });

  it("hot wallet: 150 bets of 1.00 on a 100.00 balance process exactly 100 and never go negative", async () => {
    const wallet = await harness.createWallet("100.00");

    const results = await runInParallel(150, () =>
      harness.useCase.execute(harness.command(wallet, { money: brl("1.00") })),
    );

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(100);
    expect(rejected).toHaveLength(50);
    expect(rejected.every((r) => r.failureCode === FailureCode.InsufficientFunds)).toBe(true);
    expect(rejected.every((r) => r.balance.amount === "0.00")).toBe(true);
    expect(await balanceOf(wallet.walletId)).toBe("0.00");

    // Cada saldo observado nas aprovadas é único: nenhuma aposta enxergou saldo velho.
    const observed = processed.map((r) => r.balance.amount);
    expect(new Set(observed).size).toBe(100);

    const shape = await assertWalletInvariants(wallet.walletId, db.orm.em);
    expect(shape).toEqual({ entries: 101, debits: 100, credits: 1 });
  });
});

describe("distinct wallets in parallel", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;

  beforeAll(async () => {
    db = await createTestDatabase({ poolMax: POOL_MAX });
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  it("20 wallets x 10 simultaneous bets keep every wallet consistent without lock errors", async () => {
    const WALLETS = 20;
    const BETS_PER_WALLET = 10;
    // 55.00 de saldo e apostas de 10.00: em cada wallet, 5 passam e 5 são rejeitadas.
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => harness.createWallet("55.00")),
    );

    const results = await runInParallel(WALLETS * BETS_PER_WALLET, (index) => {
      const wallet = wallets[index % WALLETS]!;
      return harness.useCase
        .execute(harness.command(wallet, { money: brl("10.00") }))
        .then((result) => ({ walletId: wallet.walletId, result }));
    });

    for (const wallet of wallets) {
      const own = results.filter((entry) => entry.walletId === wallet.walletId);
      expect(own).toHaveLength(BETS_PER_WALLET);
      expect(own.filter((e) => e.result.status === WagerTransactionStatus.Processed)).toHaveLength(5);
      expect(own.filter((e) => e.result.status === WagerTransactionStatus.Rejected)).toHaveLength(5);

      const [row] = await db.orm.em.execute<Array<{ balance: string }>>(
        "SELECT balance::text AS balance FROM wallets WHERE id = ?",
        [wallet.walletId],
      );
      expect(row?.balance).toBe("5.00");
      const shape = await assertWalletInvariants(wallet.walletId, db.orm.em);
      expect(shape).toEqual({ entries: 6, debits: 5, credits: 1 });
    }
  });
});
