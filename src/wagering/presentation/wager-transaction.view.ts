import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction-types";

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  status: WagerTransactionStatus;
  kind: WagerTransactionKind;
  money: MoneyProps;
  walletId: string;
  roundId: string;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  /** Saldo da wallet observado quando a transação foi decidida (o mesmo do replay). */
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/** Campos opcionais só aparecem quando existem, como nas demais respostas da API. */
export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    status: transaction.status,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.referenceTransactionId !== undefined
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.observedBalance !== undefined
      ? { balance: transaction.observedBalance.toJSON() }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt !== undefined
      ? { processedAt: transaction.processedAt.toISOString() }
      : {}),
  };
}
