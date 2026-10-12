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

/** Libera todos os participantes ao mesmo tempo quando o último chega. */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    await gate;
  };
}

describe("wallet row lock vs. foreign-key locks (PostgreSQL)", () => {
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

  it("does not deadlock when two transactions insert a wager transaction and then lock the same wallet", async () => {
    const { unitOfWork, walletRepo, transactionRepo, idGenerator } = ctx;
    const currency = "BRL";
    const walletId = idGenerator.generate();
    await unitOfWork.run(async () => {
      await walletRepo.insertIfAbsent(
        Wallet.open({
          id: walletId,
          playerId: "player-fk-lock",
          initialBalance: Money.from({ amount: "100.00", currency }),
        }),
      );
    });

    // Ambos inserem a transação (a FK para `wallets` toma `FOR KEY SHARE` na linha da
    // wallet) antes de qualquer um pedir o lock de escrita: é a ordem do caso de uso.
    const bothInserted = createBarrier(2);
    const submit = (n: number) =>
      unitOfWork.run(async () => {
        const inserted = await transactionRepo.insertIfAbsent(
          WagerTransaction.create({
            id: idGenerator.generate(),
            providerId: "provider-fk-lock",
            externalTransactionId: `ext-fk-lock-${n}`,
            idempotencyKey: `idem-fk-lock-${n}`,
            payloadHash: "b".repeat(64),
            walletId,
            playerId: "player-fk-lock",
            roundId: "round-fk-lock",
            gameId: "game-fk-lock",
            kind: WagerTransactionKind.Bet,
            money: Money.from({ amount: "1.00", currency }),
          }),
        );
        expect(inserted).toBe(true);
        await bothInserted();
        const wallet = await walletRepo.findByIdForUpdate(walletId);
        expect(wallet).not.toBeNull();
      });

    const outcomes = await Promise.allSettled([submit(1), submit(2)]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
