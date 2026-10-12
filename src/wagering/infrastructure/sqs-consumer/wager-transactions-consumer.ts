import type { OnApplicationBootstrap } from "@nestjs/common";
import type { SqsMessagePoller } from "../../../messaging/infrastructure/sqs/sqs-message-poller";

/**
 * Ciclo de vida do consumidor de `wager-transactions.fifo` dentro do Nest. Com o papel
 * `ENABLE_SQS_CONSUMER=false` o processo não consome nada.
 */
export class WagerTransactionsConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly poller: SqsMessagePoller,
    private readonly enabled: boolean,
  ) {}

  public onApplicationBootstrap(): void {
    if (this.enabled) {
      this.poller.start();
    }
  }
}
