import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { SqsMessagePoller } from "../../../messaging/infrastructure/sqs/sqs-message-poller";

/**
 * Ciclo de vida do consumidor de `wager-transactions.fifo` dentro do Nest. Com o papel
 * `ENABLE_SQS_CONSUMER=false` o processo não consome nada.
 *
 * No `SIGTERM` (via `enableShutdownHooks`) o poller para de buscar mensagens, espera os
 * handlers em andamento até `SHUTDOWN_TIMEOUT_MS` e devolve à fila o que não começou ou
 * estourou o prazo. A parada roda em `beforeApplicationShutdown`, e não em
 * `onApplicationShutdown`, porque os handlers ainda usam o banco: as conexões são fechadas
 * nos hooks `onApplicationShutdown` dos outros módulos, que só rodam depois deste.
 */
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly poller: SqsMessagePoller,
    private readonly enabled: boolean,
  ) {}

  public onApplicationBootstrap(): void {
    if (this.enabled) {
      this.poller.start();
    }
  }

  public async beforeApplicationShutdown(): Promise<void> {
    await this.poller.stop();
  }
}
