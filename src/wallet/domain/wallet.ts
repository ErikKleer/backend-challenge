import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
} from "../../shared/domain/domain.error";
import { Money } from "../../shared/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "./wallet-ledger-entry";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletOperationProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at?: Date;
}

/**
 * Agregado Wallet responsável por encapsular saldo e versão de concorrência.
 * Invariantes garantidas:
 * - Saldo nunca negativo
 * - Versão inicia em 1 e só incrementa se houver alteração de saldo
 * - Toda movimentação produz um WalletLedgerEntry correspondente
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma nova wallet com versão 1 e saldo inicial não negativo.
   * Não gera lançamento de ledger internamente — o use case monta o lançamento OPENING.
   */
  public static open(props: OpenWalletProps): Wallet {
    if (!props.id || typeof props.id !== "string") {
      throw new InvalidWalletError("Wallet id must be a non-empty string");
    }
    if (!props.playerId || typeof props.playerId !== "string") {
      throw new InvalidWalletError("Wallet playerId must be a non-empty string");
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance cannot be negative");
    }

    const now = props.createdAt ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /**
   * Reconstitui o agregado a partir do estado persistido sem revalidar transições.
   */
  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  // ---- Getters de estado

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- Operações de negócio

  /**
   * Debita um valor da wallet, incrementa a versão e retorna o lançamento de ledger.
   * Caso o saldo seja insuficiente, lança InsufficientFundsError e NÃO altera o estado.
   */
  public debit(props: WalletOperationProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidWalletError("Debit money amount must be positive");
    }

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `Insufficient funds: current balance ${this._balance.toString()}, required ${props.money.toString()}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(props.money);
    const newVersion = this._version + 1;
    const operationTime = props.at ?? new Date();

    // Criar o ledger entry primeiro para validar integridade contábil
    const ledgerEntry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: newVersion,
      createdAt: operationTime,
    });

    // Muta estado somente após validação contábil bem-sucedida
    this._balance = balanceAfter;
    this._version = newVersion;
    this._updatedAt = operationTime;

    return ledgerEntry;
  }

  /**
   * Credita um valor na wallet, incrementa a versão e retorna o lançamento de ledger.
   */
  public credit(props: WalletOperationProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidWalletError("Credit money amount must be positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(props.money);
    const newVersion = this._version + 1;
    const operationTime = props.at ?? new Date();

    const ledgerEntry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: newVersion,
      createdAt: operationTime,
    });

    this._balance = balanceAfter;
    this._version = newVersion;
    this._updatedAt = operationTime;

    return ledgerEntry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
