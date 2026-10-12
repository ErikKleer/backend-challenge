import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type {
  DeadLetterInfo,
  DeadLetterPublisher,
} from "../../application/dead-letter-publisher.port";
import type { QueueMessage } from "../../application/queue-message";
import type { SqsQueueUrlResolver } from "./sqs-queue-url.resolver";

/**
 * Publica na `wager-transactions-dlq.fifo` com o corpo original, o mesmo `MessageGroupId` e
 * a causa em atributos. O `MessageDeduplicationId` é o `MessageId` do SQS da mensagem de
 * origem: único por mensagem e estável entre entregas, então reenviar depois de um ack que
 * falhou não duplica a entrada na DLQ (dentro da janela de 5 min do FIFO).
 */
export class SqsDeadLetterPublisher implements DeadLetterPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: SqsQueueUrlResolver,
  ) {}

  public async send(message: QueueMessage, info: DeadLetterInfo): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl.resolve(),
        MessageBody: message.body,
        MessageGroupId: message.groupId ?? message.id,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          DeadLetterReason: { DataType: "String", StringValue: info.reason },
          ErrorCode: { DataType: "String", StringValue: info.errorCode },
          SourceMessageId: { DataType: "String", StringValue: message.id },
          ReceiveCount: { DataType: "Number", StringValue: String(message.receiveCount) },
        },
      }),
    );
  }
}
