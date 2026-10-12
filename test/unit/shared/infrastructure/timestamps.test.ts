import { describe, expect, it } from "bun:test";
import { toDate, toOptionalDate } from "../../../../src/shared/infrastructure/persistence/timestamps";
import { WagerTransactionPersistenceMapper } from "../../../../src/wagering/infrastructure/persistence/wager-transaction.mapper";
import { WalletLedgerEntryPersistenceMapper } from "../../../../src/wallet/infrastructure/persistence/wallet-ledger-entry.mapper";
import { WalletPersistenceMapper } from "../../../../src/wallet/infrastructure/persistence/wallet.mapper";

// Formato devolvido pelo driver em SQL cru (em.execute): string, não Date
const RAW = "2026-07-29 15:00:02+00";
const EXPECTED = new Date("2026-07-29T15:00:02.000Z");

describe("timestamp normalization", () => {
  it("should convert driver strings and keep Date instances", () => {
    expect(toDate(RAW)).toEqual(EXPECTED);
    expect(toDate(EXPECTED)).toBe(EXPECTED);
    expect(toOptionalDate(null)).toBeUndefined();
    expect(toOptionalDate(undefined)).toBeUndefined();
    expect(toOptionalDate(RAW)).toEqual(EXPECTED);
  });

  it("should reject an unparseable timestamp", () => {
    expect(() => toDate("not-a-date")).toThrow(TypeError);
  });

  it("should hydrate Wallet dates from raw string rows", () => {
    const wallet = WalletPersistenceMapper.toDomain({
      id: "w-1",
      playerId: "p-1",
      currency: "BRL",
      balance: "10.00",
      version: 1,
      createdAt: RAW as unknown as Date,
      updatedAt: RAW as unknown as Date,
    });

    expect(wallet.createdAt).toEqual(EXPECTED);
    expect(wallet.updatedAt).toEqual(EXPECTED);
  });

  it("should hydrate ledger entry dates from raw string rows", () => {
    const entry = WalletLedgerEntryPersistenceMapper.toDomain({
      id: "e-1",
      walletId: "w-1",
      transactionId: "t-1",
      direction: "CREDIT",
      amount: "5.00",
      currency: "BRL",
      balanceBefore: "10.00",
      balanceAfter: "15.00",
      walletVersion: 2,
      createdAt: RAW as unknown as Date,
    });

    expect(entry.createdAt).toEqual(EXPECTED);
  });

  it("should hydrate WagerTransaction dates from raw string rows", () => {
    const tx = WagerTransactionPersistenceMapper.toDomain({
      id: "t-1",
      providerId: "p",
      externalTransactionId: "x",
      idempotencyKey: "k",
      payloadHash: "a".repeat(64),
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r",
      gameId: "g",
      kind: "BET",
      status: "PROCESSED",
      amount: "5.00",
      currency: "BRL",
      observedBalance: "5.00",
      referenceAttempts: 0,
      nextReferenceAttemptAt: RAW as unknown as Date,
      createdAt: RAW as unknown as Date,
      processedAt: RAW as unknown as Date,
      updatedAt: RAW as unknown as Date,
    });

    expect(tx.createdAt).toEqual(EXPECTED);
    expect(tx.processedAt).toEqual(EXPECTED);
    expect(tx.nextReferenceAttemptAt).toEqual(EXPECTED);
  });
});
