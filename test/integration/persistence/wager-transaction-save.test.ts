import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Money } from "../../../src/shared/domain/money";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/wagering/domain/wager-transaction-types";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";

describe("WagerTransactionRepository.save (PostgreSQL)", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  async function seedPending(suffix: string): Promise<WagerTransaction> {
    const walletId = ctx.idGenerator.generate();
    const transaction = WagerTransaction.create({
      id: ctx.idGenerator.generate(),
      providerId: "provider-save",
      externalTransactionId: `ext-${suffix}`,
      idempotencyKey: `idem-${suffix}`,
      payloadHash: "c".repeat(64),
      walletId,
      playerId: `player-${suffix}`,
      roundId: "round-save",
      gameId: "game-save",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "5.00", currency: "BRL" }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await ctx.unitOfWork.run(async () => {
      await ctx.walletRepo.insertIfAbsent(
        Wallet.open({
          id: walletId,
          playerId: `player-${suffix}`,
          initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
        }),
      );
      await ctx.transactionRepo.insertIfAbsent(transaction);
    });
    return transaction;
  }

  async function updatedAtOf(id: string): Promise<string> {
    const [row] = await db.orm.em.execute<Array<{ updated_at: Date }>>(
      "SELECT updated_at FROM wager_transactions WHERE id = ?",
      [id],
    );
    return new Date(row!.updated_at).toISOString();
  }

  it("advances updated_at when the transaction is rejected", async () => {
    const transaction = await seedPending("rejected");
    const at = new Date("2026-01-01T00:00:05.000Z");

    transaction.reject(FailureCode.InsufficientFunds, Money.from({ amount: "10.00", currency: "BRL" }));
    await ctx.unitOfWork.run(() => ctx.transactionRepo.save(transaction, at));

    expect(await updatedAtOf(transaction.id)).toBe(at.toISOString());
    const stored = await ctx.transactionRepo.findById(transaction.id);
    expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
  });

  it("advances updated_at when the transaction waits for its reference", async () => {
    const transaction = await seedPending("pending");
    const at = new Date("2026-01-01T00:00:07.000Z");

    transaction.markPendingReference(
      Money.from({ amount: "10.00", currency: "BRL" }),
      new Date("2026-01-01T00:00:09.000Z"),
    );
    await ctx.unitOfWork.run(() => ctx.transactionRepo.save(transaction, at));

    expect(await updatedAtOf(transaction.id)).toBe(at.toISOString());
  });
});
