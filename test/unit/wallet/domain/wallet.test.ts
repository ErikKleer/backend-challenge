import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
} from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";
import { LedgerDirection } from "../../../../src/wallet/domain/wallet-ledger-entry";
import { Wallet } from "../../../../src/wallet/domain/wallet";

describe("Wallet Aggregate", () => {
  const initialMoney = Money.from({ amount: "100.00", currency: "BRL" });

  it("should open wallet with version 1 and matching initial balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: initialMoney,
    });

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.equals(initialMoney)).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it("should reject opening with negative initial balance or empty id/playerId", () => {
    const negativeMoney = Money.from({ amount: "-10.00", currency: "BRL" });
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: negativeMoney,
      }),
    ).toThrow(InvalidWalletError);

    expect(() =>
      Wallet.open({
        id: "",
        playerId: "player-1",
        initialBalance: initialMoney,
      }),
    ).toThrow(InvalidWalletError);

    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "",
        initialBalance: initialMoney,
      }),
    ).toThrow(InvalidWalletError);
  });

  it("should debit wallet, increment version by 1 and return balanced ledger entry", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: initialMoney,
    });

    const opTime = new Date("2026-02-01T10:00:00Z");
    const debitMoney = Money.from({ amount: "40.00", currency: "BRL" });

    const entry = wallet.debit({
      entryId: "entry-deb-1",
      transactionId: "tx-deb-1",
      money: debitMoney,
      at: opTime,
    });

    expect(wallet.balance.toJSON().amount).toBe("60.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(opTime);

    expect(entry.id).toBe("entry-deb-1");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("60.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it("should credit wallet, increment version by 1 and return balanced ledger entry", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: initialMoney,
    });

    const creditMoney = Money.from({ amount: "50.00", currency: "BRL" });
    const entry = wallet.credit({
      entryId: "entry-cred-1",
      transactionId: "tx-cred-1",
      money: creditMoney,
    });

    expect(wallet.balance.toJSON().amount).toBe("150.00");
    expect(wallet.version).toBe(2);

    expect(entry.id).toBe("entry-cred-1");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("150.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it("should reject debit when insufficient funds and NOT alter state", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: initialMoney,
    });

    const excessMoney = Money.from({ amount: "100.01", currency: "BRL" });
    const initialUpdatedAt = wallet.updatedAt;

    expect(() =>
      wallet.debit({
        entryId: "entry-excess",
        transactionId: "tx-excess",
        money: excessMoney,
      }),
    ).toThrow(InsufficientFundsError);

    // Wallet state remains unchanged
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(initialUpdatedAt);
  });

  it("should reject debit and credit with mismatched currency", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: initialMoney,
    });

    const usdMoney = Money.from({ amount: "10.00", currency: "USD" });

    expect(() =>
      wallet.debit({
        entryId: "entry-usd-deb",
        transactionId: "tx-usd-deb",
        money: usdMoney,
      }),
    ).toThrow(CurrencyMismatchError);

    expect(() =>
      wallet.credit({
        entryId: "entry-usd-cred",
        transactionId: "tx-usd-cred",
        money: usdMoney,
      }),
    ).toThrow(CurrencyMismatchError);

    expect(wallet.version).toBe(1);
  });

  it("should rehydrate without revalidating transitions", () => {
    const rehydrated = Wallet.rehydrate({
      id: "wallet-rehydrated",
      playerId: "player-rehydrated",
      currency: "BRL",
      balance: Money.from({ amount: "500.00", currency: "BRL" }),
      version: 42,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    });

    expect(rehydrated.id).toBe("wallet-rehydrated");
    expect(rehydrated.version).toBe(42);
    expect(rehydrated.balance.toJSON().amount).toBe("500.00");
  });
});
