import type { MessageAcknowledger } from "../../../messaging/application/message-acknowledger.port";
import type { QueueMessage, QueueMessageHandler } from "../../../messaging/application/queue-message";
import type { AppLogger } from "../../../shared/infrastructure/observability/app-logger";
import { bindContext, runWithContext } from "../../../shared/infrastructure/observability/execution-context";
import type { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { hashMessageContent, parseWagerTransactionMessage } from "./wager-transaction-message";

export const WAGER_TRANSACTIONS_CONSUMER_NAME = "wager-transactions-consumer";

/**
 * Processa uma mensagem de `wager-transactions.fifo` pelo **mesmo caso de uso** do HTTP.
 *
 * A inbox, o saldo, o ledger, a transação e o outbox são gravados na mesma transação SQL
 * dentro do caso de uso; este handler só confirma (`DeleteMessage`) depois que `execute`
 * retornou, ou seja, depois do commit. Se o processo morrer entre o commit e o ack, a
 * mensagem reaparece e a inbox a descarta sem repetir o efeito.
 */
export class WagerTransactionMessageHandler implements QueueMessageHandler {
  constructor(
    private readonly useCase: Pick<SubmitWagerTransactionUseCase, "execute">,
    private readonly acknowledger: MessageAcknowledger,
    private readonly logger: AppLogger,
  ) {}

  public handle(message: QueueMessage): Promise<void> {
    return runWithContext({ correlationId: message.id }, async () => {
      try {
        const parsed = parseWagerTransactionMessage(message.body);
        bindContext({ messageId: parsed.messageId });

        await this.useCase.execute(parsed.command, {
          inbox: {
            consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
            messageId: parsed.messageId,
            payloadHash: hashMessageContent(parsed.command),
          },
        });
      } catch (error) {
        // Sem ack: a mensagem volta quando a visibilidade expirar
        this.logger.warn("sqs message processing failed", {
          sqsMessageId: message.id,
          receiveCount: message.receiveCount,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      await this.acknowledge(message);
    });
  }

  private async acknowledge(message: QueueMessage): Promise<void> {
    try {
      await this.acknowledger.acknowledge(message);
    } catch (error) {
      // O efeito já está commitado: a mensagem reaparece e a inbox a descarta
      this.logger.warn("sqs message acknowledgement failed after commit", {
        sqsMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
