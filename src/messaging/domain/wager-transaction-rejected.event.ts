import { InvalidIntegrationEventError } from "../../shared/domain/domain.error";
import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import {
  type FailureCode,
  WagerTransactionStatus,
} from "../../wagering/domain/wager-transaction-types";
import { deriveEventId } from "./event-id";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  buildWagerTransactionEventData,
  type WagerTransactionEventData,
} from "./wager-transaction-event-data";

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  observedBalance?: MoneyProps;
}

/**
 * Transação rejeitada por regra de negócio (estado terminal `REJECTED`).
 */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  public readonly eventType = "WagerTransactionRejected";
  public readonly version = 1;

  public static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.Rejected || !transaction.failureCode) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionRejected requires a REJECTED transaction with failure code, got '${transaction.status}'`,
      );
    }

    return new WagerTransactionRejected({
      eventId: deriveEventId(transaction.id, "WagerTransactionRejected"),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      data: {
        ...buildWagerTransactionEventData(transaction),
        failureCode: transaction.failureCode,
        ...(transaction.observedBalance !== undefined
          ? { observedBalance: transaction.observedBalance.toJSON() }
          : {}),
      },
    });
  }
}
