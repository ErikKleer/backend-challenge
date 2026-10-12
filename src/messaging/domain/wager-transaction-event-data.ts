import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import type { WagerTransactionKind } from "../../wagering/domain/wager-transaction-types";

/**
 * Campos comuns aos eventos de ciclo de vida da transação. Valores monetários
 * sempre como `MoneyProps` (string decimal com 2 casas).
 */
export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export function buildWagerTransactionEventData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
