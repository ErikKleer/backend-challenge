import { InvalidIntegrationEventError } from "../../shared/domain/domain.error";
import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WagerTransactionStatus } from "../../wagering/domain/wager-transaction-types";
import { deriveEventId } from "./event-id";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  buildWagerTransactionEventData,
  type WagerTransactionEventData,
} from "./wager-transaction-event-data";

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  observedBalance: MoneyProps; // Saldo da wallet observado ao aplicar a transação
  processedAt: string; // ISO-8601
}

/**
 * Qualquer transação aplicada com sucesso, inclusive `LOSS` (sem efeito no saldo) e `OPENING`.
 */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  public readonly eventType = "WagerTransactionProcessed";
  public readonly version = 1;

  public static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      !transaction.observedBalance ||
      !transaction.processedAt
    ) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionProcessed requires a PROCESSED transaction with observed balance, got '${transaction.status}'`,
      );
    }

    return new WagerTransactionProcessed({
      eventId: deriveEventId(transaction.id, "WagerTransactionProcessed"),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      data: {
        ...buildWagerTransactionEventData(transaction),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        observedBalance: transaction.observedBalance.toJSON(),
        processedAt: transaction.processedAt.toISOString(),
      },
    });
  }
}
