import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Money } from "../../../src/shared/domain/money";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../../src/wagering/domain/wager-transaction-types";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";

describe("Timestamp hydration from raw SQL", () => {
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

  it("should return Date instances for wallets and transactions", async () => {
    const createdAt = new Date("2026-07-29T15:00:02.123Z");
    const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
    const wallet = Wallet.open({
      id: ctx.idGenerator.generate(),
      playerId: "player-ts",
      initialBalance: brl("10.00"),
      createdAt,
    });
    const tx = WagerTransaction.create({
      id: ctx.idGenerator.generate(),
      providerId: "provider-ts",
      externalTransactionId: "ext-ts",
      idempotencyKey: "idem-ts",
      payloadHash: "a".repeat(64),
      walletId: wallet.id,
      playerId: "player-ts",
      roundId: "r",
      gameId: "g",
      kind: WagerTransactionKind.Bet,
      money: brl("1.00"),
      createdAt,
    });

    await ctx.unitOfWork.run(async () => {
      await ctx.walletRepo.insertIfAbsent(wallet);
      await ctx.transactionRepo.insertIfAbsent(tx);
    });

    const loadedWallet = await ctx.walletRepo.findById(wallet.id);
    const loadedTx = await ctx.transactionRepo.findById(tx.id);

    expect(loadedWallet!.createdAt).toBeInstanceOf(Date);
    expect(loadedWallet!.createdAt).toEqual(createdAt);
    expect(loadedWallet!.updatedAt).toBeInstanceOf(Date);
    expect(loadedTx!.createdAt).toBeInstanceOf(Date);
    expect(loadedTx!.createdAt).toEqual(createdAt);
  });
});
