import { type FaultInjector, FaultPoint, NOOP_FAULT_INJECTOR } from "../../../shared/application/fault-injector.port";
import type { DeadLetterPublisher } from "../../../messaging/application/dead-letter-publisher.port";
import type { MessageAcknowledger } from "../../../messaging/application/message-acknowledger.port";
import type { QueueMessage, QueueMessageHandler } from "../../../messaging/application/queue-message";
import type { AppLogger } from "../../../shared/infrastructure/observability/app-logger";
import { bindContext, runWithContext } from "../../../shared/infrastructure/observability/execution-context";
import type { DlqReason, MetricsService } from "../../../shared/infrastructure/observability/metrics.service";
import type { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { classifyConsumerError, retryDelaySeconds } from "./error-classification";
import { hashMessageContent, parseWagerTransactionMessage } from "./wager-transaction-message";

export const WAGER_TRANSACTIONS_CONSUMER_NAME = "wager-transactions-consumer";

export interface WagerTransactionMessageHandlerOptions {
  /** Backoff exponencial entre entregas de uma falha transitória: `base * 2^(entrega-1)`, até `max`. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** `maxReceiveCount` da redrive policy: após essa entrega o broker move a mensagem para a DLQ. */
  maxReceiveCount: number;
}

type Disposition =
  | { action: "ack"; outcome: string }
  | { action: "retry"; code: string }
  | { action: "dead-letter"; code: string; reason: DlqReason };

/**
 * Processa uma mensagem de `wager-transactions.fifo` pelo **mesmo caso de uso** do HTTP.
 *
 * A inbox, o saldo, o ledger, a transação e o outbox são gravados na mesma transação SQL
 * dentro do caso de uso; este handler só confirma (`DeleteMessage`) depois que `execute`
 * retornou, ou seja, depois do commit. Se o processo morrer entre o commit e o ack, a
 * mensagem reaparece e a inbox a descarta sem repetir o efeito.
 *
 * Destino de cada mensagem (ADR 24):
 * - resultado de negócio, replay ou conflito de idempotência ⇒ ack;
 * - falha transitória ⇒ sem ack, `ChangeMessageVisibility` com backoff exponencial;
 * - falha permanente ⇒ DLQ (envio explícito e depois ack da fila principal).
 */
export class WagerTransactionMessageHandler implements QueueMessageHandler {
  constructor(
    private readonly useCase: Pick<SubmitWagerTransactionUseCase, "execute">,
    private readonly acknowledger: MessageAcknowledger,
    private readonly deadLetters: DeadLetterPublisher,
    private readonly logger: AppLogger,
    private readonly metrics: MetricsService,
    private readonly options: WagerTransactionMessageHandlerOptions,
    private readonly faults: FaultInjector = NOOP_FAULT_INJECTOR,
  ) {}

  public handle(message: QueueMessage): Promise<void> {
    return runWithContext({ correlationId: message.id }, async () => {
      if (message.receiveCount > 1) {
        this.metrics.recordRetry("sqs", "redelivery");
      }
      const disposition = await this.process(message);
      if (disposition.action === "ack") {
        // Só em teste: efeito commitado, mensagem ainda sem DeleteMessage
        this.faults.reach(FaultPoint.AfterCommitBeforeAck);
      }
      await this.apply(message, disposition);
    });
  }

  private async process(message: QueueMessage): Promise<Disposition> {
    try {
      const parsed = parseWagerTransactionMessage(message.body);
      bindContext({ messageId: parsed.messageId });

      const result = await this.useCase.execute(parsed.command, {
        inbox: {
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId: parsed.messageId,
          payloadHash: hashMessageContent(parsed.command),
        },
      });
      return { action: "ack", outcome: result.idempotentReplay ? "replay" : result.status };
    } catch (error) {
      const classification = classifyConsumerError(error);
      const fields = {
        sqsMessageId: message.id,
        receiveCount: message.receiveCount,
        category: classification.category,
        errorCode: classification.code,
      };
      switch (classification.category) {
        case "business":
          this.logger.info("sqs message settled with a business error", fields);
          return { action: "ack", outcome: classification.code };
        case "transient":
          this.logger.warn("sqs message failed transiently", fields);
          return { action: "retry", code: classification.code };
        case "permanent":
          this.logger.error("sqs message failed permanently", fields);
          return {
            action: "dead-letter",
            code: classification.code,
            reason: classification.dlqReason ?? "permanent_failure",
          };
      }
    }
  }

  private async apply(message: QueueMessage, disposition: Disposition): Promise<void> {
    switch (disposition.action) {
      case "ack":
        await this.acknowledge(message);
        return;
      case "retry":
        await this.scheduleRetry(message, disposition.code);
        return;
      case "dead-letter":
        await this.deadLetter(message, disposition.reason, disposition.code);
        return;
    }
  }

  /**
   * Envia à DLQ e só então apaga da fila principal. Se o envio falhar, nada foi apagado: a
   * mensagem volta como falha transitória e a redrive policy a protege de um laço infinito.
   * Se o ack falhar depois do envio, a mensagem reaparece e é reenviada com o mesmo
   * `MessageDeduplicationId`, que o FIFO descarta.
   */
  private async deadLetter(message: QueueMessage, reason: DlqReason, code: string): Promise<void> {
    try {
      await this.deadLetters.send(message, { reason, errorCode: code });
    } catch (error) {
      this.logger.error("sqs message could not be sent to the DLQ", {
        sqsMessageId: message.id,
        errorCode: code,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.scheduleRetry(message, "DLQ_UNAVAILABLE");
      return;
    }
    this.metrics.recordDlqMessage(reason);
    this.logger.error("sqs message moved to the DLQ", {
      sqsMessageId: message.id,
      receiveCount: message.receiveCount,
      reason,
      errorCode: code,
    });
    await this.acknowledge(message);
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

  /**
   * Adia a próxima entrega. Sem ack, a mensagem volta sozinha; o que se controla é o quanto
   * esperar. O limite de tentativas é da redrive policy: depois de `maxReceiveCount` entregas
   * o broker a move para a DLQ.
   */
  private async scheduleRetry(message: QueueMessage, code: string): Promise<void> {
    const delaySeconds = retryDelaySeconds(
      message.receiveCount,
      this.options.retryBaseSeconds,
      this.options.retryMaxSeconds,
    );
    this.metrics.recordRetry("sqs", "transient_failure");
    const exhausted = message.receiveCount >= this.options.maxReceiveCount;
    if (exhausted) {
      this.logger.error("sqs message exhausted its deliveries; the broker will move it to the DLQ", {
        sqsMessageId: message.id,
        receiveCount: message.receiveCount,
        errorCode: code,
      });
      this.metrics.recordDlqMessage("max_receive_count");
    }

    try {
      await this.acknowledger.changeVisibility(message, delaySeconds);
    } catch (error) {
      // Sem a mudança, a mensagem volta ao fim da visibilidade original
      this.logger.warn("sqs retry delay could not be applied", {
        sqsMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
