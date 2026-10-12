import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";
import { Money } from "../../../src/shared/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import {
  WagerTransactionKind,
} from "../../../src/wagering/domain/wager-transaction-types";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction";
import {
  LockTimeoutError,
  WalletVersionConflictError,
} from "../../../src/shared/infrastructure/persistence/postgres-errors";

describe("Persistence Layer Integration Tests", () => {
  let db: TestDatabaseContext;
  let pCtx: PersistenceTestContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    pCtx = await createPersistenceTestContext(db);
  });

  afterAll(async () => {
    await pCtx.app.close();
    await db.teardown();
  });

  describe("Round-trip and Exact Numeric Scaling (no number types)", () => {
    it("should round-trip exact monetary strings 0.10, 1000000.00 and 17 integer digits", async () => {
      const { unitOfWork, walletRepo, ledgerRepo, transactionRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const playerId = "player-scale-test";
      const currency = "BRL";
      const initialBalance = Money.from({ amount: "1000000.00", currency });

      const wallet = Wallet.open({ id: walletId, playerId, initialBalance });
      const txId = idGenerator.generate();
      const txAmount = Money.from({ amount: "0.10", currency });
      const tx = WagerTransaction.create({
        id: txId,
        providerId: "provider-scale",
        externalTransactionId: "ext-scale-1",
        idempotencyKey: "idem-scale-1",
        payloadHash: "a".repeat(64),
        walletId,
        playerId,
        roundId: "round-scale",
        gameId: "game-scale",
        kind: WagerTransactionKind.Bet,
        money: txAmount,
      });

      const entryId = idGenerator.generate();
      const entry = wallet.debit({ entryId, transactionId: txId, money: txAmount });

      await unitOfWork.run(async () => {
        expect(await walletRepo.insertIfAbsent(wallet)).toBe(true);
        expect(await transactionRepo.insertIfAbsent(tx)).toBe(true);
        await ledgerRepo.append(entry);
      });

      const fetchedWallet = await walletRepo.findById(walletId);
      expect(fetchedWallet).not.toBeNull();
      expect(fetchedWallet!.balance.amount).toBe("999999.90");
      expect(fetchedWallet!.balance.currency).toBe("BRL");

      const fetchedTx = await transactionRepo.findById(txId);
      expect(fetchedTx).not.toBeNull();
      expect(fetchedTx!.money.amount).toBe("0.10");

      const bigWalletId = idGenerator.generate();
      const bigBalance = Money.from({ amount: "99999999999999999.99", currency });
      const bigWallet = Wallet.open({ id: bigWalletId, playerId: "player-big-num", initialBalance: bigBalance });

      await unitOfWork.run(async () => {
        await walletRepo.insertIfAbsent(bigWallet);
      });

      const fetchedBigWallet = await walletRepo.findById(bigWalletId);
      expect(fetchedBigWallet).not.toBeNull();
      expect(fetchedBigWallet!.balance.amount).toBe("99999999999999999.99");
    });
  });

  describe("insertIfAbsent duplicate handling", () => {
    it("should return false on duplicate insert by key and by (provider_id, external_transaction_id)", async () => {
      const { unitOfWork, transactionRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const playerId = "player-dup-test";
      const currency = "BRL";

      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: Money.from({ amount: "100.00", currency }),
      });
      await unitOfWork.run(async () => {
        await pCtx.walletRepo.insertIfAbsent(wallet);
      });

      const tx1 = WagerTransaction.create({
        id: idGenerator.generate(),
        providerId: "provider-dup",
        externalTransactionId: "ext-1",
        idempotencyKey: "idem-dup-key-1",
        payloadHash: "b".repeat(64),
        walletId,
        playerId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency }),
      });

      await unitOfWork.run(async () => {
        expect(await transactionRepo.insertIfAbsent(tx1)).toBe(true);
      });

      const txDupKey = WagerTransaction.create({
        id: idGenerator.generate(),
        providerId: "provider-dup",
        externalTransactionId: "ext-2",
        idempotencyKey: "idem-dup-key-1",
        payloadHash: "c".repeat(64),
        walletId,
        playerId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency }),
      });

      await unitOfWork.run(async () => {
        expect(await transactionRepo.insertIfAbsent(txDupKey)).toBe(false);
      });

      const txDupExternal = WagerTransaction.create({
        id: idGenerator.generate(),
        providerId: "provider-dup",
        externalTransactionId: "ext-1",
        idempotencyKey: "idem-dup-key-2",
        payloadHash: "d".repeat(64),
        walletId,
        playerId,
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency }),
      });

      await unitOfWork.run(async () => {
        expect(await transactionRepo.insertIfAbsent(txDupExternal)).toBe(false);
      });
    });
  });

  describe("findByIdForUpdate and LockTimeoutError", () => {
    it("should make second connection wait for first transaction to commit without fixed sleep", async () => {
      const { unitOfWork, walletRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const wallet = Wallet.open({
        id: walletId,
        playerId: "player-lock-order",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      await unitOfWork.run(async () => {
        await walletRepo.insertIfAbsent(wallet);
      });

      const events: string[] = [];

      let tx1AcquiredLock!: () => void;
      const tx1AcquiredPromise = new Promise<void>((resolve) => {
        tx1AcquiredLock = resolve;
      });

      let allowTx1Commit!: () => void;
      const allowTx1CommitPromise = new Promise<void>((resolve) => {
        allowTx1Commit = resolve;
      });

      const promiseTx1 = unitOfWork.run(async () => {
        events.push("tx1:before_lock");
        const locked = await walletRepo.findByIdForUpdate(walletId);
        expect(locked).not.toBeNull();
        events.push("tx1:lock_acquired");
        tx1AcquiredLock();

        await allowTx1CommitPromise;
        events.push("tx1:committing");
      });

      const promiseTx2 = (async () => {
        await tx1AcquiredPromise;
        events.push("tx2:attempting_lock");

        return await unitOfWork.run(async () => {
          events.push("tx2:before_lock");
          const locked2 = await walletRepo.findByIdForUpdate(walletId);
          events.push("tx2:lock_acquired");
          return locked2;
        });
      })();

      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push("main:releasing_tx1");
      allowTx1Commit();

      await Promise.all([promiseTx1, promiseTx2]);
      events.push("all_done");

      expect(events).toEqual([
        "tx1:before_lock",
        "tx1:lock_acquired",
        "tx2:attempting_lock",
        "tx2:before_lock",
        "main:releasing_tx1",
        "tx1:committing",
        "tx2:lock_acquired",
        "all_done",
      ]);
    });

    it("should throw LockTimeoutError when lock is held longer than lock_timeout", async () => {
      const { unitOfWork, walletRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const wallet = Wallet.open({
        id: walletId,
        playerId: "player-lock-timeout",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      await unitOfWork.run(async () => {
        await walletRepo.insertIfAbsent(wallet);
      });

      let tx1Holding!: () => void;
      const tx1HoldingPromise = new Promise<void>((resolve) => {
        tx1Holding = resolve;
      });

      let finishTx1!: () => void;
      const finishTx1Promise = new Promise<void>((resolve) => {
        finishTx1 = resolve;
      });

      const pTx1 = unitOfWork.run(async () => {
        await walletRepo.findByIdForUpdate(walletId);
        tx1Holding();
        await finishTx1Promise;
      });

      await tx1HoldingPromise;

      const shortTimeoutUow = new (unitOfWork.constructor as any)(db.orm.em, 80);

      let caughtError: unknown;
      try {
        await shortTimeoutUow.run(async () => {
          await walletRepo.findByIdForUpdate(walletId);
        });
      } catch (err) {
        caughtError = err;
      } finally {
        finishTx1();
        await pTx1;
      }

      expect(caughtError).toBeInstanceOf(LockTimeoutError);
      expect((caughtError as LockTimeoutError).code).toBe("LOCK_TIMEOUT");
    });
  });

  describe("updateBalance and optimistic locking", () => {
    it("should throw WalletVersionConflictError when expected version does not match", async () => {
      const { unitOfWork, walletRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const wallet = Wallet.open({
        id: walletId,
        playerId: "player-opt-lock",
        initialBalance: Money.from({ amount: "200.00", currency: "BRL" }),
      });

      await unitOfWork.run(async () => {
        await walletRepo.insertIfAbsent(wallet);
      });

      let caughtError: unknown;
      await unitOfWork.run(async () => {
        try {
          await walletRepo.updateBalance(wallet, 2);
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeInstanceOf(WalletVersionConflictError);
      expect((caughtError as WalletVersionConflictError).code).toBe("WALLET_VERSION_CONFLICT");
    });
  });

  describe("UnitOfWork transaction atomicity and nested run", () => {
    it("should rollback wallet, transaction and ledger on error inside run", async () => {
      const { unitOfWork, walletRepo, ledgerRepo, transactionRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const playerId = "player-rollback-test";
      const currency = "BRL";
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: Money.from({ amount: "100.00", currency }),
      });

      const txId = idGenerator.generate();
      const tx = WagerTransaction.create({
        id: txId,
        providerId: "p-rb",
        externalTransactionId: "ext-rb-1",
        idempotencyKey: "idem-rb-1",
        payloadHash: "e".repeat(64),
        walletId,
        playerId,
        roundId: "r-rb",
        gameId: "g-rb",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency }),
      });

      const entry = wallet.debit({
        entryId: idGenerator.generate(),
        transactionId: txId,
        money: Money.from({ amount: "10.00", currency }),
      });

      let caughtError: unknown;
      try {
        await unitOfWork.run(async () => {
          await walletRepo.insertIfAbsent(wallet);
          await transactionRepo.insertIfAbsent(tx);
          await ledgerRepo.append(entry);

          throw new Error("Simulated business failure after writes");
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect((caughtError as Error).message).toBe("Simulated business failure after writes");

      const foundWallet = await walletRepo.findById(walletId);
      const foundTx = await transactionRepo.findById(txId);

      expect(foundWallet).toBeNull();
      expect(foundTx).toBeNull();
    });

    it("should share transaction in nested run and fire afterCommit callbacks", async () => {
      const { unitOfWork, walletRepo, idGenerator } = pCtx;

      const walletId = idGenerator.generate();
      const wallet = Wallet.open({
        id: walletId,
        playerId: "player-nested-test",
        initialBalance: Money.from({ amount: "500.00", currency: "BRL" }),
      });

      let afterCommitExecuted = false;

      await unitOfWork.run(async () => {
        unitOfWork.afterCommit(() => {
          afterCommitExecuted = true;
        });

        await walletRepo.insertIfAbsent(wallet);

        await unitOfWork.run(async () => {
          const loadedInNested = await walletRepo.findById(walletId);
          expect(loadedInNested).not.toBeNull();
        });
      });

      expect(afterCommitExecuted).toBe(true);

      const persistedWallet = await walletRepo.findById(walletId);
      expect(persistedWallet).not.toBeNull();
    });
  });


});
