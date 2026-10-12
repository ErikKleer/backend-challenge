import { describe, expect, it } from "bun:test";
import { deriveEventId, uuidV5 } from "../../../../src/messaging/domain/event-id";
import type { EventContext } from "../../../../src/messaging/domain/integration-event";
import { WagerTransactionPendingReference } from "../../../../src/messaging/domain/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../../../src/messaging/domain/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../../../src/messaging/domain/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../../../src/messaging/domain/wallet-balance-changed.event";
import { InvalidIntegrationEventError } from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";
import { WagerTransaction } from "../../../../src/wagering/domain/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
} from "../../../../src/wagering/domain/wager-transaction-types";
import { Wallet } from "../../../../src/wallet/domain/wallet";
import { LedgerDirection } from "../../../../src/wallet/domain/wallet-ledger-entry";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const TX_ID = "0192f292-0000-7000-8000-000000000001";
const ENTRY_ID = "0192f292-0000-7000-8000-0000000000e1";
const NOW = new Date("2026-07-29T15:00:00.123Z");
const ctx: EventContext = { correlationId: "corr-1", causationId: "msg-1", now: NOW };

function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

function newTransaction(kind: WagerTransactionKind, amount = "25.00"): WagerTransaction {
  const isReversal =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  return WagerTransaction.create({
    id: TX_ID,
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    payloadHash: "a".repeat(64),
    walletId: WALLET_ID,
    playerId: "player-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    ...(isReversal ? { referenceExternalTransactionId: "transaction-100" } : {}),
  });
}

describe("uuidV5 / deriveEventId", () => {
  it("should match the RFC 4122 reference vector for python.org in the DNS namespace", () => {
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("should derive the same eventId for the same transaction and event type", () => {
    expect(deriveEventId(TX_ID, "WalletBalanceChanged")).toBe(
      deriveEventId(TX_ID, "WalletBalanceChanged"),
    );
  });

  it("should derive different eventIds per event type and per transaction", () => {
    const a = deriveEventId(TX_ID, "WagerTransactionProcessed");
    const b = deriveEventId(TX_ID, "WalletBalanceChanged");
    const c = deriveEventId("0192f292-0000-7000-8000-000000000002", "WagerTransactionProcessed");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("should produce a valid UUID v5", () => {
    expect(deriveEventId(TX_ID, "WagerTransactionProcessed")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("WagerTransactionProcessed", () => {
  it("should serialize the exact envelope with ISO-8601 dates and MoneyProps strings", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, brl("75.00"), new Date("2026-07-29T14:59:59.000Z"));

    const event = WagerTransactionProcessed.from(tx, ctx);

    expect(event.toJSON()).toEqual({
      eventId: deriveEventId(TX_ID, "WagerTransactionProcessed"),
      eventType: "WagerTransactionProcessed",
      aggregateId: WALLET_ID,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-07-29T15:00:00.123Z",
      version: 1,
      data: {
        transactionId: TX_ID,
        walletId: WALLET_ID,
        playerId: "player-1",
        providerId: "provider-a",
        externalTransactionId: "transaction-123",
        roundId: "round-987",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
        observedBalance: { amount: "75.00", currency: "BRL" },
        processedAt: "2026-07-29T14:59:59.000Z",
      },
    });
  });

  it("should cover LOSS, which does not change the balance", () => {
    const tx = newTransaction(WagerTransactionKind.Loss, "0.00");
    tx.markProcessed(undefined, brl("75.00"), NOW);

    const event = WagerTransactionProcessed.from(tx, ctx);

    expect(event.data.kind).toBe(WagerTransactionKind.Loss);
    expect(event.aggregateId).toBe(WALLET_ID);
  });

  it("should omit causationId from the envelope when absent", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, brl("75.00"), NOW);

    const json = WagerTransactionProcessed.from(tx, { correlationId: "corr-1", now: NOW }).toJSON();

    expect("causationId" in json).toBe(false);
  });

  it("should include referenceTransactionId for reversals", () => {
    const tx = newTransaction(WagerTransactionKind.Refund);
    tx.markProcessed("0192f292-0000-7000-8000-000000000099", brl("100.00"), NOW);

    expect(WagerTransactionProcessed.from(tx, ctx).data.referenceTransactionId).toBe(
      "0192f292-0000-7000-8000-000000000099",
    );
  });

  it("should reject a transaction that is not PROCESSED", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe("WagerTransactionRejected", () => {
  it("should include failureCode and observed balance", () => {
    const tx = newTransaction(WagerTransactionKind.Bet, "500.00");
    tx.reject(FailureCode.InsufficientFunds, brl("100.00"));

    const json = WagerTransactionRejected.from(tx, ctx).toJSON();

    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.eventId).toBe(deriveEventId(TX_ID, "WagerTransactionRejected"));
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.observedBalance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("should omit observedBalance when unknown", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    tx.reject(FailureCode.CurrencyMismatch);

    expect("observedBalance" in WagerTransactionRejected.from(tx, ctx).data).toBe(false);
  });

  it("should reject a transaction that is not REJECTED", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe("WagerTransactionPendingReference", () => {
  it("should carry the external reference awaited", () => {
    const tx = newTransaction(WagerTransactionKind.Rollback);
    tx.markPendingReference(brl("100.00"), new Date("2026-07-29T15:00:02.000Z"));

    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();

    expect(json.eventType).toBe("WagerTransactionPendingReference");
    expect(json.eventId).toBe(deriveEventId(TX_ID, "WagerTransactionPendingReference"));
    expect(json.aggregateId).toBe(WALLET_ID);
    expect(json.data.referenceExternalTransactionId).toBe("transaction-100");
  });

  it("should reject a transaction that is not PENDING_REFERENCE", () => {
    const tx = newTransaction(WagerTransactionKind.Rollback);
    expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe("WalletBalanceChanged", () => {
  function debitedWallet() {
    const wallet = Wallet.open({ id: WALLET_ID, playerId: "player-1", initialBalance: brl("100.00") });
    const entry = wallet.debit({ entryId: ENTRY_ID, transactionId: TX_ID, money: brl("25.00"), at: NOW });
    return { wallet, entry };
  }

  it("should serialize the README data shape with MoneyProps strings", () => {
    const { wallet, entry } = debitedWallet();

    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toEqual({
      eventId: deriveEventId(TX_ID, "WalletBalanceChanged"),
      eventType: "WalletBalanceChanged",
      aggregateId: WALLET_ID,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-07-29T15:00:00.123Z",
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: TX_ID,
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  it("should reject a ledger entry from another wallet", () => {
    const { entry } = debitedWallet();
    const other = Wallet.open({
      id: "0192f291-27dd-7d3f-8071-000000000000",
      playerId: "player-2",
      initialBalance: brl("10.00"),
    });

    expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe("Event payloads", () => {
  it("should never carry Money instances or numeric monetary values", () => {
    const tx = newTransaction(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, brl("75.00"), NOW);
    const wallet = Wallet.open({ id: WALLET_ID, playerId: "player-1", initialBalance: brl("100.00") });
    const entry = wallet.debit({ entryId: ENTRY_ID, transactionId: TX_ID, money: brl("25.00"), at: NOW });

    const events = [
      WagerTransactionProcessed.from(tx, ctx),
      WalletBalanceChanged.from(wallet, entry, ctx),
    ];

    for (const event of events) {
      const visit = (value: unknown): void => {
        expect(value instanceof Money).toBe(false);
        if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) {
            if (key === "amount") expect(typeof child).toBe("string");
            visit(child);
          }
        }
      };
      visit(event.toJSON());
    }
  });
});
