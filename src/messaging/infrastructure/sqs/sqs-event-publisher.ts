import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/event-publisher.port";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { SqsQueueUrlResolver } from "./sqs-queue-url.resolver";

/**
 * Publica o envelope do outbox em `wager-events.fifo`.
 *
 * - `MessageGroupId = aggregateId` (a wallet): o SQS ordena o que chega por wallet.
 * - `MessageDeduplicationId = eventId`: o broker descarta o mesmo evento reenviado dentro da
 *   janela de 5 minutos do FIFO. É um alívio, não a garantia: a consistência vem da dedup
 *   por `eventId` no consumidor (README §5.3).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: SqsQueueUrlResolver,
  ) {}

  public async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl.resolve(),
        // O payload do outbox já é o envelope do evento; só é serializado aqui
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
}
