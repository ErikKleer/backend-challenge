import { describe, expect, it } from "bun:test";
import { InvalidLedgerEntryError } from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../../src/wallet/domain/wallet-ledger-entry";

describe("WalletLedgerEntry", () => {
  const defaultProps = {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Credit,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
    balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
    walletVersion: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("should create valid CREDIT ledger entry and verify arithmetic", () => {
    const entry = WalletLedgerEntry.create(defaultProps);

    expect(entry.id).toBe("entry-1");
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it("should create valid DEBIT ledger entry and verify arithmetic", () => {
    const entry = WalletLedgerEntry.create({
      ...defaultProps,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: "40.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "60.00", currency: "BRL" }),
    });

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  it("should reject entry when arithmetic does not balance", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        direction: LedgerDirection.Credit,
        balanceAfter: Money.from({ amount: "130.00", currency: "BRL" }), // should be 125.00
      }),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        direction: LedgerDirection.Debit,
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        money: Money.from({ amount: "20.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "70.00", currency: "BRL" }), // should be 80.00
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("should reject non-positive money", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        money: Money.zero("BRL"),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "100.00", currency: "BRL" }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("should reject currency mismatch across money and balances", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        money: Money.from({ amount: "25.00", currency: "USD" }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("should reject invalid walletVersion", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        walletVersion: 0,
      }),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        ...defaultProps,
        walletVersion: 1.5,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("should rehydrate without revalidating transitions", () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: "entry-rehydrate",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "0.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "10.00", currency: "BRL" }),
      walletVersion: 1,
      createdAt: new Date(),
    });

    expect(entry.id).toBe("entry-rehydrate");
    expect(entry.isBalanced()).toBe(true);
  });
});
