import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ReadinessCheck } from "../../../shared/application/readiness-check.port";
import type { SqsQueueUrlResolver } from "./sqs-queue-url.resolver";

/**
 * `GetQueueAttributes` da fila de transações. A URL é cacheada pelo resolver, mas o
 * `GetQueueAttributes` roda a cada sondagem: é ele que prova que o broker responde e que
 * a fila ainda existe.
 */
export class SqsReadinessCheck implements ReadinessCheck {
  public readonly name = "sqs";

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: SqsQueueUrlResolver,
  ) {}

  public async check(signal: AbortSignal): Promise<void> {
    const url = await this.queueUrl.resolve();
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }),
      { abortSignal: signal },
    );
  }
}
