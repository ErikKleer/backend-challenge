import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
  InvalidWalletError,
} from "../../../../src/shared/domain/domain.error";

describe("Domain Errors", () => {
  it("should extend DomainError and Error with proper codes and messages", () => {
    const invalidMoney = new InvalidMoneyError("Invalid format");
    expect(invalidMoney).toBeInstanceOf(DomainError);
    expect(invalidMoney).toBeInstanceOf(Error);
    expect(invalidMoney.code).toBe("INVALID_MONEY");
    expect(invalidMoney.message).toBe("Invalid format");

    const currencyMismatch = new CurrencyMismatchError("BRL", "USD");
    expect(currencyMismatch).toBeInstanceOf(DomainError);
    expect(currencyMismatch.code).toBe("CURRENCY_MISMATCH");
    expect(currencyMismatch.message).toContain("expected 'BRL', got 'USD'");

    const insufficientFunds = new InsufficientFundsError();
    expect(insufficientFunds).toBeInstanceOf(DomainError);
    expect(insufficientFunds.code).toBe("INSUFFICIENT_FUNDS");
    expect(insufficientFunds.message).toBe("Insufficient funds for the requested debit operation");

    const invalidLedger = new InvalidLedgerEntryError("Ledger is not balanced");
    expect(invalidLedger).toBeInstanceOf(DomainError);
    expect(invalidLedger.code).toBe("INVALID_LEDGER_ENTRY");
    expect(invalidLedger.message).toBe("Ledger is not balanced");

    const invalidWallet = new InvalidWalletError("Initial balance cannot be negative");
    expect(invalidWallet).toBeInstanceOf(DomainError);
    expect(invalidWallet.code).toBe("INVALID_WALLET");
    expect(invalidWallet.message).toBe("Initial balance cannot be negative");
  });
});
