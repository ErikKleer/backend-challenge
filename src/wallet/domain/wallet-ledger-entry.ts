import { InvalidLedgerEntryError } from "../../shared/domain/domain.error";
import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",   // Saída de saldo da wallet
  Credit = "CREDIT", // Entrada de saldo na wallet
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

/**
 * Registro de lançamento contábil imutável da wallet.
 * Sem métodos de transição — imutabilidade estrutural completa.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  /**
   * Factory de criação com validação rigorosa de aritmética e invariantes contábeis.
   */
  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || typeof props.id !== "string") {
      throw new InvalidLedgerEntryError("Ledger entry id must be a non-empty string");
    }
    if (!props.walletId || typeof props.walletId !== "string") {
      throw new InvalidLedgerEntryError("Ledger entry walletId must be a non-empty string");
    }
    if (!props.transactionId || typeof props.transactionId !== "string") {
      throw new InvalidLedgerEntryError("Ledger entry transactionId must be a non-empty string");
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError("Ledger entry money amount must be positive");
    }

    if (props.balanceBefore.isNegative()) {
      throw new InvalidLedgerEntryError("Ledger entry balanceBefore cannot be negative");
    }

    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("Ledger entry balanceAfter cannot be negative");
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError("Currencies of money, balanceBefore and balanceAfter must match");
    }

    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError("Ledger entry walletVersion must be an integer >= 1");
    }

    const calculatedAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!calculatedAfter.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `Ledger entry arithmetic mismatch: balanceBefore (${props.balanceBefore}) ` +
          `${props.direction === LedgerDirection.Debit ? "-" : "+"} money (${props.money}) ` +
          `does not equal balanceAfter (${props.balanceAfter})`,
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt ?? new Date(),
    );
  }

  /**
   * Reconstrução a partir do banco de dados — não revalida regras de transição.
   */
  public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /**
   * Verifica se balanceBefore ± money === balanceAfter.
   */
  public isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
