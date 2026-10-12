import { InvalidIntegrationEventError } from "../../shared/domain/domain.error";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WagerTransactionStatus } from "../../wagering/domain/wager-transaction-types";
import { deriveEventId } from "./event-id";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  buildWagerTransactionEventData,
  type WagerTransactionEventData,
} from "./wager-transaction-event-data";

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

/**
 * Transação que depende de uma referência ainda inexistente ou não finalizada
 * (`PENDING_REFERENCE`). Emitido uma única vez por transação; as tentativas seguintes
 * do worker não geram novos eventos.
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  public readonly eventType = "WagerTransactionPendingReference";
  public readonly version = 1;

  public static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !transaction.referenceExternalTransactionId
    ) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionPendingReference requires a PENDING_REFERENCE transaction with a reference, got '${transaction.status}'`,
      );
    }

    return new WagerTransactionPendingReference({
      eventId: deriveEventId(transaction.id, "WagerTransactionPendingReference"),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      data: {
        ...buildWagerTransactionEventData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
