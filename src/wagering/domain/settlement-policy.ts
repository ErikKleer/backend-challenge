import type { Money } from "../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import type { WagerTransaction } from "./wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction-types";

export type SettlementDecision =
  | {
      readonly type: "APPLY";
      readonly direction: LedgerDirection;
      readonly money: Money;
    }
  | {
      readonly type: "NO_BALANCE_EFFECT";
    }
  | {
      readonly type: "REJECT";
      readonly code: FailureCode;
    }
  | {
      readonly type: "PENDING_REFERENCE";
    };

export interface SettlementContext {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  existingReversal?: WagerTransaction;
}
/**
 * Função/serviço puro de política de liquidação financeira do wagering.
 * Decide estritamente sem efeitos colaterais sobre transação, carteira ou banco.
 */
export class SettlementPolicy {
  public static decide(context: SettlementContext): SettlementDecision {
    const { transaction, wallet, reference, existingReversal } = context;

    // Regra 1: Moeda da operação deve ser idêntica à da wallet; playerId deve ser o dono da wallet
    if (transaction.money.currency !== wallet.currency) {
      return { type: "REJECT", code: FailureCode.CurrencyMismatch };
    }
    if (transaction.playerId !== wallet.playerId) {
      return { type: "REJECT", code: FailureCode.PlayerWalletMismatch };
    }

    // Regra 2: BET — saldo < valor => REJECT INSUFFICIENT_FUNDS; senão APPLY DEBIT
    if (transaction.kind === WagerTransactionKind.Bet) {
      if (wallet.balance.isLessThan(transaction.money)) {
        return { type: "REJECT", code: FailureCode.InsufficientFunds };
      }
      return {
        type: "APPLY",
        direction: LedgerDirection.Debit,
        money: transaction.money,
      };
    }

    // Regra 3: WIN e LOSS
    // WIN e LOSS aceitam referência opcional. Se não houver referência, seguem o fluxo direto.
    const isWinOrLoss =
      transaction.kind === WagerTransactionKind.Win ||
      transaction.kind === WagerTransactionKind.Loss;

    if (isWinOrLoss && !transaction.referenceExternalTransactionId) {
      if (transaction.kind === WagerTransactionKind.Loss) {
        return { type: "NO_BALANCE_EFFECT" };
      }
      return {
        type: "APPLY",
        direction: LedgerDirection.Credit,
        money: transaction.money,
      };
    }

    // Regra 4: REFUND / ROLLBACK e (WIN / LOSS com referência)
    if (!reference) {
      return { type: "PENDING_REFERENCE" };
    }

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { type: "PENDING_REFERENCE" };
    }

    if (
      reference.status === WagerTransactionStatus.Rejected ||
      reference.status === WagerTransactionStatus.Failed
    ) {
      return { type: "REJECT", code: FailureCode.ReferenceNotProcessed };
    }

    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return { type: "REJECT", code: FailureCode.ReferenceMismatch };
    }

    // Regra 5: Tipo da referência
    if (isWinOrLoss && reference.kind !== WagerTransactionKind.Bet) {
      return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
    }

    if (
      transaction.kind === WagerTransactionKind.Refund &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
    }

    if (transaction.kind === WagerTransactionKind.Rollback) {
      const allowedRollbackKinds = [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ];
      if (!allowedRollbackKinds.includes(reference.kind)) {
        return { type: "REJECT", code: FailureCode.InvalidReferenceKind };
      }
    }

    // Regra 6: Valor da transação deve ser estritamente igual ao valor da referência
    if (
      transaction.kind === WagerTransactionKind.Refund ||
      transaction.kind === WagerTransactionKind.Rollback
    ) {
      if (!transaction.money.equals(reference.money)) {
        return { type: "REJECT", code: FailureCode.ReferenceAmountMismatch };
      }
    }

    // Regra 7: existingReversal presente => ALREADY_REVERSED
    if (existingReversal) {
      return { type: "REJECT", code: FailureCode.AlreadyReversed };
    }

    if (transaction.kind === WagerTransactionKind.Win) {
      return {
        type: "APPLY",
        direction: LedgerDirection.Credit,
        money: transaction.money,
      };
    }

    if (transaction.kind === WagerTransactionKind.Loss) {
      return { type: "NO_BALANCE_EFFECT" };
    }

    // Regra 8: Reversão que é débito com saldo insuficiente
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
      return { type: "REJECT", code: FailureCode.ReversalWouldOverdraw };
    }

    // Regra 9: Caso contrário, APPLY com a direção contábil determinada
    return {
      type: "APPLY",
      direction,
      money: transaction.money,
    };
  }
}

