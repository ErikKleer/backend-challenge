import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../../src/shared/infrastructure/observability/metrics.service";
import { WalletAlreadyExistsError } from "../../../src/shared/domain/domain.error";
import { Money } from "../../../src/shared/domain/money";
import {
  CreateWalletUseCase,
  openingIdempotencyKey,
} from "../../../src/wallet/application/create-wallet.use-case";
import type { LedgerRepository } from "../../../src/wallet/application/ledger.repository.port";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";

interface Counts {
  wallets: number;
  transactions: number;
  ledger: number;
  outbox: number;
}

describe("CreateWalletUseCase (PostgreSQL)", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  const logger = new AppLogger({ level: "silent" });
  const metrics = new MetricsService({ collectDefaults: false });

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  function buildUseCase(ledger: LedgerRepository = ctx.ledgerRepo): CreateWalletUseCase {
    return new CreateWalletUseCase(
      ctx.unitOfWork,
      ctx.walletRepo,
      ctx.transactionRepo,
      ledger,
      ctx.outboxRepo,
      ctx.idGenerator,
      ctx.clock,
      logger,
      metrics,
    );
  }

  const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

  async function counts(): Promise<Counts> {
    const [row] = await db.orm.em.execute<Array<Record<keyof Counts, string>>>(
      `SELECT (SELECT COUNT(*) FROM wallets) AS wallets,
              (SELECT COUNT(*) FROM wager_transactions) AS transactions,
              (SELECT COUNT(*) FROM wallet_ledger_entries) AS ledger,
              (SELECT COUNT(*) FROM outbox_messages) AS outbox`,
    );
    return {
      wallets: Number(row?.wallets),
      transactions: Number(row?.transactions),
      ledger: Number(row?.ledger),
      outbox: Number(row?.outbox),
    };
  }

  it("creates wallet, OPENING transaction, CREDIT entry and two outbox events atomically", async () => {
    const wallet = await buildUseCase().execute({
      playerId: "player-opening",
      initialBalance: brl("1000.00"),
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("1000.00");

    const walletRows = await db.orm.em.execute<Array<Record<string, unknown>>>(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = ?",
      [wallet.id],
    );
    expect(walletRows).toEqual([{ balance: "1000.00", version: 1 }]);

    const txRows = await db.orm.em.execute<Array<Record<string, unknown>>>(
      `SELECT id, kind, status, provider_id, external_transaction_id, idempotency_key,
              round_id, game_id, amount::text AS amount, observed_balance::text AS observed_balance,
              payload_hash, processed_at
         FROM wager_transactions WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(txRows).toHaveLength(1);
    const tx = txRows[0]!;
    expect(tx).toMatchObject({
      kind: "OPENING",
      status: "PROCESSED",
      provider_id: "internal",
      external_transaction_id: openingIdempotencyKey(wallet.id),
      idempotency_key: openingIdempotencyKey(wallet.id),
      round_id: "opening",
      game_id: "opening",
      amount: "1000.00",
      observed_balance: "1000.00",
    });
    expect(String(tx.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.processed_at).not.toBeNull();

    const ledgerRows = await db.orm.em.execute<Array<Record<string, unknown>>>(
      `SELECT transaction_id, direction, amount::text AS amount, balance_before::text AS balance_before,
              balance_after::text AS balance_after, wallet_version
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(ledgerRows).toEqual([
      {
        transaction_id: tx.id,
        direction: "CREDIT",
        amount: "1000.00",
        balance_before: "0.00",
        balance_after: "1000.00",
        wallet_version: 1,
      },
    ]);

    const outboxRows = await db.orm.em.execute<Array<{ event_type: string; aggregate_id: string }>>(
      "SELECT event_type, aggregate_id FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type",
      [wallet.id],
    );
    expect(outboxRows.map((row) => row.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    await assertLedgerMatchesBalance(wallet.id, db.orm.em);
  });

  it("creates only the wallet when the initial balance is zero", async () => {
    const before = await counts();

    const wallet = await buildUseCase().execute({
      playerId: "player-zero",
      initialBalance: brl("0.00"),
    });

    expect(await counts()).toEqual({ ...before, wallets: before.wallets + 1 });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("0.00");
    await assertLedgerMatchesBalance(wallet.id, db.orm.em);
  });

  it("allows the same player to hold wallets in different currencies", async () => {
    const useCase = buildUseCase();
    await useCase.execute({ playerId: "player-multi", initialBalance: brl("1.00") });

    const usd = await useCase.execute({
      playerId: "player-multi",
      initialBalance: Money.from({ amount: "2.00", currency: "USD" }),
    });

    expect(usd.currency).toBe("USD");
  });

  it("rejects a duplicate (playerId, currency) and leaves nothing behind", async () => {
    const useCase = buildUseCase();
    await useCase.execute({ playerId: "player-dup", initialBalance: brl("5.00") });
    const before = await counts();

    await expect(
      useCase.execute({ playerId: "player-dup", initialBalance: brl("9.00") }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    expect(await counts()).toEqual(before);
  });

  it("leaves the database untouched when a failure happens mid-way", async () => {
    const failingLedger: LedgerRepository = {
      findPage: (...args) => ctx.ledgerRepo.findPage(...args),
      append: async (_entry: WalletLedgerEntry) => {
        throw new Error("injected ledger failure");
      },
    };
    const before = await counts();

    await expect(
      buildUseCase(failingLedger).execute({
        playerId: "player-rollback",
        initialBalance: brl("100.00"),
      }),
    ).rejects.toThrow("injected ledger failure");

    expect(await counts()).toEqual(before);
    const rows = await db.orm.em.execute<unknown[]>(
      "SELECT 1 FROM wallets WHERE player_id = ?",
      ["player-rollback"],
    );
    expect(rows).toHaveLength(0);
  });

  it("creates exactly one wallet when 10 identical requests race", async () => {
    const useCase = buildUseCase();
    const before = await counts();

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = Array.from({ length: 10 }, async () => {
      await barrier;
      return useCase.execute({ playerId: "player-race", initialBalance: brl("50.00") });
    });
    release();
    const results = await Promise.allSettled(attempts);

    const created = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletAlreadyExistsError);
    }

    expect(await counts()).toEqual({
      wallets: before.wallets + 1,
      transactions: before.transactions + 1,
      ledger: before.ledger + 1,
      outbox: before.outbox + 2,
    });
    const walletId = (created[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await assertLedgerMatchesBalance(walletId, db.orm.em);
  });
});
