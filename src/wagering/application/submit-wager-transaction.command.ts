import type { Money } from "../../shared/domain/money";
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction-types";

/** Tipos aceitos nas bordas: `OPENING` é interno e nunca chega por HTTP ou SQS. */
export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/** Identidade da mensagem SQS que originou o comando; deduplicada pela inbox. */
export interface InboxOptions {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerTransactionOptions {
  inbox?: InboxOptions;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado e gravado na transação; no replay, o saldo da época. */
  balance: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
