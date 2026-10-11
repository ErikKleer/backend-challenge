import { InvalidTransactionStateError } from "../../shared/domain/domain.error";
import type { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction-types";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.id || typeof props.id !== "string") {
      throw new InvalidTransactionStateError("Transaction id must be a non-empty string");
    }
    if (!props.providerId || typeof props.providerId !== "string") {
      throw new InvalidTransactionStateError("Transaction providerId must be a non-empty string");
    }
    if (!props.externalTransactionId || typeof props.externalTransactionId !== "string") {
      throw new InvalidTransactionStateError("Transaction externalTransactionId must be a non-empty string");
    }
    if (!props.idempotencyKey || typeof props.idempotencyKey !== "string") {
      throw new InvalidTransactionStateError("Transaction idempotencyKey must be a non-empty string");
    }
    if (!props.payloadHash || typeof props.payloadHash !== "string") {
      throw new InvalidTransactionStateError("Transaction payloadHash must be a non-empty string");
    }
    if (!props.walletId || typeof props.walletId !== "string") {
      throw new InvalidTransactionStateError("Transaction walletId must be a non-empty string");
    }
    if (!props.playerId || typeof props.playerId !== "string") {
      throw new InvalidTransactionStateError("Transaction playerId must be a non-empty string");
    }
    if (!props.roundId || typeof props.roundId !== "string") {
      throw new InvalidTransactionStateError("Transaction roundId must be a non-empty string");
    }
    if (!props.gameId || typeof props.gameId !== "string") {
      throw new InvalidTransactionStateError("Transaction gameId must be a non-empty string");
    }

    const requiresRef =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (requiresRef && (!props.referenceExternalTransactionId || typeof props.referenceExternalTransactionId !== "string")) {
      throw new InvalidTransactionStateError(
        `Transaction kind '${props.kind}' requires referenceExternalTransactionId`,
      );
    }

    if (props.kind === WagerTransactionKind.Loss) {
      if (props.money.isNegative()) {
        throw new InvalidTransactionStateError("LOSS transaction money amount cannot be negative");
      }
    } else {
      if (!props.money.isPositive()) {
        throw new InvalidTransactionStateError(
          `Transaction kind '${props.kind}' requires positive money amount, received ${props.money.toString()}`,
        );
      }
    }

    const now = props.createdAt ?? new Date();

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      now,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }
  // ---- Getters de estado

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  public get processedAt(): Date | undefined {
    return this._processedAt;
  }

  public get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  public get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  public get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- Transições de estado

  public markProcessed(
    referenceTransactionId: string | undefined,
    observedBalance: Money,
    at: Date = new Date(),
  ): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    if (referenceTransactionId) {
      this._referenceTransactionId = referenceTransactionId;
    }
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  public markPendingReference(
    observedBalance?: Money,
    nextAttemptAt?: Date,
  ): void {
    this.assertCanTransitionTo(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  public scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Cannot schedule reference retry for transaction in status '${this._status}'. Must be PENDING_REFERENCE`,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  public reject(code: FailureCode, observedBalance?: Money): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
    this._nextReferenceAttemptAt = undefined;
  }

  public fail(code: FailureCode = FailureCode.PermanentInfrastructureError): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- Consultas de domínio

  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  public requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            "ROLLBACK requires the referenced transaction to determine ledger direction",
          );
        }
        const refDirection = reference.ledgerDirectionFor();
        return refDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }

      case WagerTransactionKind.Loss:
      default:
        throw new InvalidTransactionStateError(
          `Transaction kind '${this.kind}' does not produce a ledger entry`,
        );
    }
  }

  // ---- Auxiliares privados

  private assertCanTransitionTo(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition transaction from terminal status '${this._status}' to '${target}'`,
      );
    }

    if (
      this._status === WagerTransactionStatus.Pending &&
      (target === WagerTransactionStatus.Processed ||
        target === WagerTransactionStatus.PendingReference ||
        target === WagerTransactionStatus.Rejected ||
        target === WagerTransactionStatus.Failed)
    ) {
      return;
    }

    if (
      this._status === WagerTransactionStatus.PendingReference &&
      (target === WagerTransactionStatus.Processed ||
        target === WagerTransactionStatus.Rejected ||
        target === WagerTransactionStatus.Failed)
    ) {
      return;
    }

    throw new InvalidTransactionStateError(
      `Invalid transition from '${this._status}' to '${target}'`,
    );
  }
}


