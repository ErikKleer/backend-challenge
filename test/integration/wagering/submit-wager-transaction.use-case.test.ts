import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { IdempotencyConflictError, WalletNotFoundError } from "../../../src/shared/domain/domain.error";
import { Money } from "../../../src/shared/domain/money";
import type { SubmitWagerTransactionCommand } from "../../../src/wagering/application/submit-wager-transaction.command";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/wagering/domain/wager-transaction-types";
import type { LedgerRepository } from "../../../src/wallet/application/ledger.repository.port";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry";
import { createBarrier } from "../../support/barrier";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";
import {
  createPersistenceTestContext,
  type PersistenceTestContext,
} from "../../support/persistence";
import { brl, TEST_PENDING_POLICY, type WalletFixture, WageringHarness } from "../../support/wagering";

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

interface LedgerRow {
  direction: string;
  amount: string;
  wallet_version: number;
  transaction_id: string;
}

describe("SubmitWagerTransactionUseCase (PostgreSQL)", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  const submit = (command: SubmitWagerTransactionCommand) => harness.useCase.execute(command);

  async function ledgerOf(walletId: string): Promise<LedgerRow[]> {
    // O lançamento OPENING (versão 1) fica de fora: interessa o que o caso de uso gravou.
    return db.orm.em.execute<LedgerRow[]>(
      `SELECT direction, amount::text AS amount, wallet_version, transaction_id
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version > 1
        ORDER BY wallet_version`,
      [walletId],
    );
  }

  async function walletOf(walletId: string): Promise<{ balance: string; version: number }> {
    const [row] = await db.orm.em.execute<Array<{ balance: string; version: number }>>(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = ?",
      [walletId],
    );
    return row!;
  }

  async function countTransactions(walletId: string): Promise<number> {
    const [row] = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
      [walletId],
    );
    return Number(row!.n);
  }

  describe("balance effects", () => {
    it("BET debits the wallet and writes exactly one DEBIT entry", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(harness.command(wallet, { money: brl("30.00") }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });
      expect(result.idempotentReplay).toBe(false);
      expect(result.failureCode).toBeUndefined();
      expect(await ledgerOf(wallet.walletId)).toEqual([
        { direction: "DEBIT", amount: "30.00", wallet_version: 2, transaction_id: result.transactionId },
      ]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("WIN credits the wallet", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(harness.command(wallet, { kind: Win, money: brl("25.50") }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("125.50");
      expect((await ledgerOf(wallet.walletId)).map((row) => row.direction)).toEqual(["CREDIT"]);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("LOSS records the result without ledger entry or version change", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(harness.command(wallet, { kind: Loss, money: brl("0.00") }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("100.00");
      expect(await ledgerOf(wallet.walletId)).toEqual([]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("keeps exact decimal arithmetic across many small movements", async () => {
      const wallet = await harness.createWallet("1.00");

      for (let i = 0; i < 10; i += 1) {
        await submit(harness.command(wallet, { money: brl("0.10") }));
      }

      expect(await walletOf(wallet.walletId)).toEqual({ balance: "0.00", version: 11 });
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });
  });

  describe("reversals", () => {
    async function bet(wallet: WalletFixture, amount: string, externalTransactionId: string) {
      return submit(harness.command(wallet, { externalTransactionId, money: brl(amount) }));
    }

    it("REFUND returns the amount of a processed BET", async () => {
      const wallet = await harness.createWallet("100.00");
      const placed = await bet(wallet, "40.00", "bet-refund");

      const result = await submit(
        harness.command(wallet, {
          kind: Refund,
          money: brl("40.00"),
          referenceExternalTransactionId: "bet-refund",
        }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("100.00");
      const rows = await ledgerOf(wallet.walletId);
      expect(rows.map((row) => row.direction)).toEqual(["DEBIT", "CREDIT"]);
      const [stored] = await db.orm.em.execute<Array<{ reference_transaction_id: string }>>(
        "SELECT reference_transaction_id FROM wager_transactions WHERE id = ?",
        [result.transactionId],
      );
      expect(stored?.reference_transaction_id).toBe(placed.transactionId);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("ROLLBACK of a BET credits the wallet", async () => {
      const wallet = await harness.createWallet("100.00");
      await bet(wallet, "40.00", "bet-rb");

      const result = await submit(
        harness.command(wallet, { kind: Rollback, money: brl("40.00"), referenceExternalTransactionId: "bet-rb" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("100.00");
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("ROLLBACK of a WIN debits the wallet", async () => {
      const wallet = await harness.createWallet("100.00");
      await submit(harness.command(wallet, { kind: Win, money: brl("60.00"), externalTransactionId: "win-rb" }));

      const result = await submit(
        harness.command(wallet, { kind: Rollback, money: brl("60.00"), referenceExternalTransactionId: "win-rb" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("100.00");
      expect((await ledgerOf(wallet.walletId)).map((row) => row.direction)).toEqual(["CREDIT", "DEBIT"]);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("ROLLBACK of a REFUND debits the wallet again", async () => {
      const wallet = await harness.createWallet("100.00");
      await bet(wallet, "40.00", "bet-rb-refund");
      await submit(
        harness.command(wallet, {
          kind: Refund,
          money: brl("40.00"),
          externalTransactionId: "refund-rb",
          referenceExternalTransactionId: "bet-rb-refund",
        }),
      );

      const result = await submit(
        harness.command(wallet, { kind: Rollback, money: brl("40.00"), referenceExternalTransactionId: "refund-rb" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("60.00");
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("rejects a second reversal of the same transaction with ALREADY_REVERSED", async () => {
      const wallet = await harness.createWallet("100.00");
      await bet(wallet, "40.00", "bet-twice");
      await submit(
        harness.command(wallet, { kind: Refund, money: brl("40.00"), referenceExternalTransactionId: "bet-twice" }),
      );

      const second = await submit(
        harness.command(wallet, { kind: Rollback, money: brl("40.00"), referenceExternalTransactionId: "bet-twice" }),
      );
      const third = await submit(
        harness.command(wallet, { kind: Refund, money: brl("40.00"), referenceExternalTransactionId: "bet-twice" }),
      );

      for (const result of [second, third]) {
        expect(result.status).toBe(WagerTransactionStatus.Rejected);
        expect(result.failureCode).toBe(FailureCode.AlreadyReversed);
        expect(result.balance.amount).toBe("100.00");
      }
      expect(await ledgerOf(wallet.walletId)).toHaveLength(2);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("rejects ROLLBACK of a WIN that was already spent with REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS", async () => {
      const wallet = await harness.createWallet("100.00");
      await submit(harness.command(wallet, { kind: Win, money: brl("50.00"), externalTransactionId: "win-spent" }));
      await bet(wallet, "150.00", "bet-all");

      const result = await submit(
        harness.command(wallet, { kind: Rollback, money: brl("50.00"), referenceExternalTransactionId: "win-spent" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
      expect(result.balance.amount).toBe("0.00");
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("rejects a reversal whose amount differs from the reference", async () => {
      const wallet = await harness.createWallet("100.00");
      await bet(wallet, "40.00", "bet-amount");

      const result = await submit(
        harness.command(wallet, { kind: Refund, money: brl("30.00"), referenceExternalTransactionId: "bet-amount" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it("rejects a reference from another round", async () => {
      const wallet = await harness.createWallet("100.00");
      await submit(harness.command(wallet, { externalTransactionId: "bet-round", roundId: "round-A" }));

      const result = await submit(
        harness.command(wallet, {
          kind: Refund,
          roundId: "round-B",
          referenceExternalTransactionId: "bet-round",
        }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
    });

    it("rejects a reference that belongs to another wallet", async () => {
      const wallet = await harness.createWallet("100.00");
      const other = await harness.createWallet("100.00");
      await submit(harness.command(other, { externalTransactionId: "bet-other-wallet" }));

      const result = await submit(
        harness.command(wallet, { kind: Refund, referenceExternalTransactionId: "bet-other-wallet" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
      await assertLedgerMatchesBalance(other.walletId, db.orm.em);
    });

    it("rejects a REFUND that references a WIN", async () => {
      const wallet = await harness.createWallet("100.00");
      await submit(harness.command(wallet, { kind: Win, externalTransactionId: "win-refund" }));

      const result = await submit(
        harness.command(wallet, { kind: Refund, referenceExternalTransactionId: "win-refund" }),
      );

      expect(result.failureCode).toBe(FailureCode.InvalidReferenceKind);
    });
  });

  describe("business rejections", () => {
    it("persists an INSUFFICIENT_FUNDS rejection without touching balance, version or ledger", async () => {
      const wallet = await harness.createWallet("50.00");

      const result = await submit(harness.command(wallet, { money: brl("80.00") }));

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(result.balance.amount).toBe("50.00");
      expect(await ledgerOf(wallet.walletId)).toEqual([]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "50.00", version: 1 });
      const [stored] = await db.orm.em.execute<Array<{ status: string; failure_code: string; observed_balance: string }>>(
        "SELECT status, failure_code, observed_balance::text AS observed_balance FROM wager_transactions WHERE id = ?",
        [result.transactionId],
      );
      expect(stored).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", observed_balance: "50.00" });
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("rejects an operation in a different currency than the wallet", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(
        harness.command(wallet, { money: Money.from({ amount: "10.00", currency: "USD" }) }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    });

    it("rejects an operation by a player who does not own the wallet", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(harness.command(wallet, { playerId: "someone-else" }));

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.PlayerWalletMismatch);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    });

    it("answers WalletNotFoundError and stores nothing for an unknown wallet", async () => {
      const ghost: WalletFixture = { walletId: ctx.idGenerator.generate(), playerId: "ghost" };
      const command = harness.command(ghost);

      await expect(submit(command)).rejects.toBeInstanceOf(WalletNotFoundError);

      const [row] = await db.orm.em.execute<Array<{ n: string }>>(
        "SELECT COUNT(*) AS n FROM wager_transactions WHERE idempotency_key = ?",
        [command.idempotencyKey],
      );
      expect(row?.n).toBe("0");
    });
  });

  describe("pending reference", () => {
    it("stores a reversal whose reference is unknown as PENDING_REFERENCE with a retry time", async () => {
      const wallet = await harness.createWallet("100.00");

      const result = await submit(
        harness.command(wallet, { kind: Refund, referenceExternalTransactionId: "not-yet-there" }),
      );

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      expect(result.balance.amount).toBe("100.00");
      expect(result.failureCode).toBeUndefined();
      const [stored] = await db.orm.em.execute<
        Array<{ status: string; attempts: number; delay_ms: string }>
      >(
        `SELECT status, reference_attempts AS attempts,
                (EXTRACT(EPOCH FROM (next_reference_attempt_at - created_at)) * 1000)::text AS delay_ms
           FROM wager_transactions WHERE id = ?`,
        [result.transactionId],
      );
      expect(stored?.status).toBe("PENDING_REFERENCE");
      expect(stored?.attempts).toBe(0);
      expect(Number(stored?.delay_ms)).toBe(TEST_PENDING_POLICY.baseDelayMs);
      expect(await ledgerOf(wallet.walletId)).toEqual([]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    });

    it("replays a pending transaction with its current status", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { kind: Refund, referenceExternalTransactionId: "later" });
      const first = await submit(command);

      const replay = await submit(command);

      expect(replay.transactionId).toBe(first.transactionId);
      expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
      expect(replay.idempotentReplay).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("replays the original result, including the balance observed at the time", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });
      const first = await submit(command);
      await submit(harness.command(wallet, { kind: Win, money: brl("500.00") }));

      const replay = await submit(command);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId).toBe(first.transactionId);
      expect(replay.status).toBe(WagerTransactionStatus.Processed);
      expect(replay.balance.amount).toBe("70.00");
      expect(await ledgerOf(wallet.walletId)).toHaveLength(2);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("replays a rejection with its failure code", async () => {
      const wallet = await harness.createWallet("10.00");
      const command = harness.command(wallet, { money: brl("80.00") });
      await submit(command);

      const replay = await submit(command);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.status).toBe(WagerTransactionStatus.Rejected);
      expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it("rejects the same key with a different payload as a conflict, never a replay", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });
      await submit(command);

      await expect(submit({ ...command, money: brl("31.00") })).rejects.toBeInstanceOf(IdempotencyConflictError);

      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
    });

    it("rejects the same (provider, external id) under another key as a conflict", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });
      await submit(command);

      await expect(
        submit({ ...command, idempotencyKey: `${command.idempotencyKey}:other` }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      expect(await countTransactions(wallet.walletId)).toBe(1);
    });

    it("allows the same external id for different providers", async () => {
      const wallet = await harness.createWallet("100.00");
      const a = harness.command(wallet, { providerId: "provider-a", externalTransactionId: "shared-id" });
      const b = harness.command(wallet, { providerId: "provider-b", externalTransactionId: "shared-id" });

      const [first, second] = [await submit(a), await submit(b)];

      expect(first.transactionId).not.toBe(second.transactionId);
      expect(second.balance.amount).toBe("80.00");
    });
  });

  describe("atomicity", () => {
    it("persists nothing when a failure follows the ledger append", async () => {
      const failingLedger: LedgerRepository = {
        append: async (entry: WalletLedgerEntry) => {
          await ctx.ledgerRepo.append(entry);
          throw new Error("injected failure after ledger append");
        },
      };
      const failing = new WageringHarness(ctx, { ledger: failingLedger });
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });

      await expect(failing.useCase.execute(command)).rejects.toThrow("injected failure after ledger append");

      expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
      expect(await ledgerOf(wallet.walletId)).toEqual([]);
      expect(await countTransactions(wallet.walletId)).toBe(0);
      expect(await failing.metrics.render()).not.toContain("wager_transactions_total{");
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);

      // A mesma requisição, agora sem falha, é processada como primeira vez.
      const retry = await submit(command);
      expect(retry.idempotentReplay).toBe(false);
      expect(retry.balance.amount).toBe("70.00");
    });
  });

  describe("inbox", () => {
    const inbox = (messageId: string) => ({
      consumerName: "wager-transactions-consumer",
      messageId,
      payloadHash: "d".repeat(64),
    });

    it("records the message and returns the stored result for a redelivery without reprocessing", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });
      const first = await harness.useCase.execute(command, { inbox: inbox("msg-1") });

      const redelivery = await harness.useCase.execute(command, { inbox: inbox("msg-1") });

      expect(first.idempotentReplay).toBe(false);
      expect(redelivery).toEqual({ ...first, idempotentReplay: true });
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "70.00", version: 2 });
      const [row] = await db.orm.em.execute<Array<{ processed: boolean }>>(
        "SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id = 'msg-1'",
      );
      expect(row?.processed).toBe(true);
    });

    it("rolls the inbox record back together with a failed processing", async () => {
      const failingLedger: LedgerRepository = {
        append: async (entry: WalletLedgerEntry) => {
          await ctx.ledgerRepo.append(entry);
          throw new Error("injected failure");
        },
      };
      const failing = new WageringHarness(ctx, { ledger: failingLedger });
      const wallet = await harness.createWallet("100.00");

      await expect(
        failing.useCase.execute(harness.command(wallet), { inbox: inbox("msg-rollback") }),
      ).rejects.toThrow("injected failure");

      const [row] = await db.orm.em.execute<Array<{ n: string }>>(
        "SELECT COUNT(*) AS n FROM inbox_messages WHERE message_id = 'msg-rollback'",
      );
      expect(row?.n).toBe("0");
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two simultaneous BETs of 80.00 succeed on a 100.00 wallet", async () => {
      const wallet = await harness.createWallet("100.00");
      const start = createBarrier(2);
      const attempt = async () => {
        const command = harness.command(wallet, { money: brl("80.00") });
        await start();
        return submit(command);
      };

      const results = await Promise.all([attempt(), attempt()]);

      expect(results.map((result) => result.status).sort()).toEqual([
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
      ]);
      expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)?.failureCode).toBe(
        FailureCode.InsufficientFunds,
      );
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await ledgerOf(wallet.walletId)).toHaveLength(1);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("never overdraws under 12 simultaneous BETs and keeps the ledger consistent", async () => {
      const wallet = await harness.createWallet("100.00");
      const start = createBarrier(12);
      const attempt = async () => {
        const command = harness.command(wallet, { money: brl("30.00") });
        await start();
        return submit(command);
      };

      const results = await Promise.all(Array.from({ length: 12 }, attempt));

      expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(3);
      expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(9);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: "10.00", version: 4 });
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });

    it("applies a request submitted 8 times at once exactly once", async () => {
      const wallet = await harness.createWallet("100.00");
      const command = harness.command(wallet, { money: brl("30.00") });
      const start = createBarrier(8);
      const attempt = async () => {
        await start();
        return submit(command);
      };

      const results = await Promise.all(Array.from({ length: 8 }, attempt));

      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
      expect(new Set(results.map((result) => result.balance.amount))).toEqual(new Set(["70.00"]));
      expect(await ledgerOf(wallet.walletId)).toHaveLength(1);
      await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
    });
  });

  describe("metrics", () => {
    it("counts transactions, replays, conflicts and durations", async () => {
      const metricsHarness = new WageringHarness(ctx);
      const wallet = await metricsHarness.createWallet("100.00");
      const command = metricsHarness.command(wallet, { money: brl("30.00") });

      await metricsHarness.useCase.execute(command);
      await metricsHarness.useCase.execute(command);
      await metricsHarness.useCase
        .execute({ ...command, money: brl("31.00") })
        .catch(() => undefined);

      const text = await metricsHarness.metrics.render();
      expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED",failure_code="NONE"} 1');
      expect(text).toContain('wager_duplicates_total{source="http",type="replay"} 1');
      expect(text).toContain('wager_duplicates_total{source="http",type="conflict"} 1');
      expect(text).toContain('wager_processing_duration_seconds_count{source="http",outcome="processed"} 1');
      expect(text).toContain('wager_processing_duration_seconds_count{source="http",outcome="replay"} 1');
      expect(text).toContain('wager_processing_duration_seconds_count{source="http",outcome="conflict"} 1');
    });
  });
});
