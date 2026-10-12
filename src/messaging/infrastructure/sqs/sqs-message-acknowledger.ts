import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { MessageAcknowledger } from "../../application/message-acknowledger.port";
import type { QueueMessage } from "../../application/queue-message";
import type { SqsQueueUrlResolver } from "./sqs-queue-url.resolver";

export class SqsMessageAcknowledger implements MessageAcknowledger {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: SqsQueueUrlResolver,
  ) {}

  public async acknowledge(message: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl.resolve(),
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  public async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl.resolve(),
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
