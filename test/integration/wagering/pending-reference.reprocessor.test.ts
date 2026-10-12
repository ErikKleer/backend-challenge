import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SubmittableKind } from "../../../src/wagering/application/submit-wager-transaction.command";
import type { LedgerRepository } from "../../../src/wallet/application/ledger.repository.port";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/wagering/domain/wager-transaction-types";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";
import { metricValue, MutableClock } from "../../support/outbox";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { brl, WageringHarness, type WalletFixture } from "../../support/wagering";

const { Bet, Win, Refund, Rollback } = WagerTransactionKind;

const BACKOFF = { baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 8 };

interface StoredTransaction {
  status: string;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | string | null;
  observed_balance: string;
}

/** Falha injetada em volta do ledger real: as `failFirst` primeiras gravações rejeitam. */
class FaultyLedger implements LedgerRepository {
  public failures: number;

  constructor(
    private readonly inner: LedgerRepository,
    failFirst: number,
  ) {
    this.failures = failFirst;
  }

  public async append(entry: WalletLedgerEntry): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("injected ledger failure");
    }
    await this.inner.append(entry);
  }

  public findPage(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    return this.inner.findPage(walletId, afterVersion, limit);
  }
}

describe("PendingReferenceReprocessor (PostgreSQL)", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  const clock = new MutableClock(new Date());
  let harness: WageringHarness;

  // Banco por teste: as pendentes de um teste seriam reclamadas pelo ciclo do seguinte
  beforeEach(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx, { pendingPolicy: BACKOFF, clock });
  });

  afterEach(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  const advance = (ms: number): void => clock.set(new Date(clock.now().getTime() + ms));

  async function storedOf(transactionId: string): Promise<StoredTransaction> {
    const [row] = await db.orm.em.execute<StoredTransaction[]>(
      `SELECT status, failure_code, reference_attempts AS attempts,
              next_reference_attempt_at AS next_attempt_at, observed_balance::text AS observed_balance
         FROM wager_transactions WHERE id = ?`,
      [transactionId],
    );
    return row!;
  }

  async function walletOf(walletId: string): Promise<{ balance: string; version: number }> {
    const [row] = await db.orm.em.execute<Array<{ balance: string; version: number }>>(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = ?",
      [walletId],
    );
    return row!;
  }

  async function ledgerKinds(walletId: string): Promise<string[]> {
    const rows = await db.orm.em.execute<Array<{ direction: string; amount: string }>>(
      `SELECT direction, amount::text AS amount FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version > 1 ORDER BY wallet_version`,
      [walletId],
    );
    return rows.map((row) => `${row.direction} ${row.amount}`);
  }

  async function eventTypes(transactionId: string): Promise<string[]> {
    const rows = await db.orm.em.execute<Array<{ event_type: string }>>(
      `SELECT event_type FROM outbox_messages
        WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, event_type`,
      [transactionId],
    );
    return rows.map((row) => row.event_type);
  }

  function pendingReversal(wallet: WalletFixture, kind: SubmittableKind, reference: string, amount = "10.00") {
    return harness.command(wallet, {
      kind,
      referenceExternalTransactionId: reference,
      money: brl(amount),
    });
  }

  it("does nothing while the retry time has not arrived", async () => {
    const wallet = await harness.createWallet("100.00");
    const refund = await harness.useCase.execute(pendingReversal(wallet, Refund, "bet-later"));
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    expect((await harness.reprocessor.runOnce()).claimed).toBe(0);
    expect((await storedOf(refund.transactionId)).attempts).toBe(0);

    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });

  it("processes a REFUND delivered before its BET once the BET arrives", async () => {
    const wallet = await harness.createWallet("100.00");
    const refundCommand = pendingReversal(wallet, Refund, "bet-1");
    const refund = await harness.useCase.execute(refundCommand);
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await harness.useCase.execute(
      harness.command(wallet, { externalTransactionId: "bet-1", kind: Bet, money: brl("10.00") }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    advance(BACKOFF.baseDelayMs + 1);
    expect((await harness.reprocessor.runOnce()).claimed).toBe(1);

    const stored = await storedOf(refund.transactionId);
    expect(stored).toMatchObject({ status: "PROCESSED", observed_balance: "100.00", next_attempt_at: null });
    expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    expect(await ledgerKinds(wallet.walletId)).toEqual(["DEBIT 10.00", "CREDIT 10.00"]);
    expect(await eventTypes(refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    // Replay do provedor devolve o resultado final, sem novo efeito
    const replay = await harness.useCase.execute(refundCommand);
    expect(replay).toMatchObject({
      transactionId: refund.transactionId,
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
    });
    expect(replay.balance.amount).toBe("100.00");
    expect((await harness.reprocessor.runOnce()).claimed).toBe(0);
    expect(await ledgerKinds(wallet.walletId)).toHaveLength(2);

    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });

  it("processes a ROLLBACK delivered before its WIN and debits the prize", async () => {
    const wallet = await harness.createWallet("100.00");
    const rollback = await harness.useCase.execute(pendingReversal(wallet, Rollback, "win-1", "25.00"));
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    await harness.useCase.execute(
      harness.command(wallet, { externalTransactionId: "win-1", kind: Win, money: brl("25.00") }),
    );
    advance(BACKOFF.baseDelayMs + 1);
    await harness.reprocessor.runOnce();

    expect((await storedOf(rollback.transactionId)).status).toBe("PROCESSED");
    expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    expect(await ledgerKinds(wallet.walletId)).toEqual(["CREDIT 25.00", "DEBIT 25.00"]);
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });

  it("rejects a pending ROLLBACK with REVERSAL_WOULD_OVERDRAW when the prize was already spent", async () => {
    const wallet = await harness.createWallet("0.00");
    const rollback = await harness.useCase.execute(pendingReversal(wallet, Rollback, "win-2", "25.00"));
    await harness.useCase.execute(
      harness.command(wallet, { externalTransactionId: "win-2", kind: Win, money: brl("25.00") }),
    );
    // O prêmio é gasto antes de a reversão ser reprocessada
    const spend = await harness.useCase.execute(harness.command(wallet, { kind: Bet, money: brl("20.00") }));
    expect(spend.status).toBe(WagerTransactionStatus.Processed);

    advance(BACKOFF.baseDelayMs + 1);
    await harness.reprocessor.runOnce();

    expect(await storedOf(rollback.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: FailureCode.ReversalWouldOverdraw,
      observed_balance: "5.00",
    });
    expect(await walletOf(wallet.walletId)).toMatchObject({ balance: "5.00" });
    expect(await ledgerKinds(wallet.walletId)).toEqual(["CREDIT 25.00", "DEBIT 20.00"]);
    expect(await eventTypes(rollback.transactionId)).toContain("WagerTransactionRejected");
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });

  it("backs off exponentially up to the cap while the reference is still missing", async () => {
    const wallet = await harness.createWallet("100.00");
    const refund = await harness.useCase.execute(pendingReversal(wallet, Refund, "never-yet"));
    const retriesBefore = await metricValue(harness.metrics, "wager_retries_total");

    // tentativa 1 ⇒ 20 ms; 2 ⇒ 40 ms (teto); 3 ⇒ 40 ms (teto)
    for (const [attempts, delay] of [
      [1, 20],
      [2, 40],
      [3, 40],
    ] as const) {
      advance(BACKOFF.maxDelayMs + 1);
      expect((await harness.reprocessor.runOnce()).claimed).toBe(1);
      const stored = await storedOf(refund.transactionId);
      expect(stored.status).toBe("PENDING_REFERENCE");
      expect(stored.attempts).toBe(attempts);
      expect(new Date(stored.next_attempt_at!).getTime()).toBe(clock.now().getTime() + delay);
    }

    expect(await metricValue(harness.metrics, "wager_retries_total")).toBe(retriesBefore + 3);
    // Esperar de novo não repete o evento de pendência
    expect(await eventTypes(refund.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    expect(await ledgerKinds(wallet.walletId)).toEqual([]);
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });

  it("keeps the transaction pending when reprocessing fails midway and redoes it later without duplicating", async () => {
    const wallet = await harness.createWallet("100.00");
    const faulty = new FaultyLedger(ctx.ledgerRepo, 0);
    const faultyHarness = new WageringHarness(ctx, { pendingPolicy: BACKOFF, clock, ledger: faulty });

    const refund = await faultyHarness.useCase.execute(pendingReversal(wallet, Refund, "bet-crash"));
    await faultyHarness.useCase.execute(
      faultyHarness.command(wallet, { externalTransactionId: "bet-crash", kind: Bet }),
    );
    advance(BACKOFF.baseDelayMs + 1);

    // O saldo já foi alterado quando o ledger falha: o rollback tem que desfazer tudo
    faulty.failures = 1;
    await expect(faultyHarness.reprocessor.runOnce()).rejects.toThrow("injected ledger failure");

    const afterFailure = await storedOf(refund.transactionId);
    expect(afterFailure).toMatchObject({ status: "PENDING_REFERENCE", attempts: 0 });
    expect(await walletOf(wallet.walletId)).toEqual({ balance: "90.00", version: 2 });
    expect(await ledgerKinds(wallet.walletId)).toEqual(["DEBIT 10.00"]);
    expect(await eventTypes(refund.transactionId)).toEqual(["WagerTransactionPendingReference"]);

    // Segue vencida: o ciclo seguinte refaz o trabalho uma única vez
    expect((await faultyHarness.reprocessor.runOnce()).claimed).toBe(1);
    expect((await faultyHarness.reprocessor.runOnce()).claimed).toBe(0);
    expect((await storedOf(refund.transactionId)).status).toBe("PROCESSED");
    expect(await walletOf(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    expect(await ledgerKinds(wallet.walletId)).toEqual(["DEBIT 10.00", "CREDIT 10.00"]);
    await assertLedgerMatchesBalance(wallet.walletId, db.orm.em);
  });
});
