import { ReceiveMessageCommand, type Message, type SQSClient } from "@aws-sdk/client-sqs";
import type { MessageAcknowledger } from "../../application/message-acknowledger.port";
import type { QueueMessage, QueueMessageHandler } from "../../application/queue-message";
import type { AppLogger } from "../../../shared/infrastructure/observability/app-logger";
import type { SqsQueueUrlResolver } from "./sqs-queue-url.resolver";

export interface SqsMessagePollerOptions {
  /** Long polling: quanto o broker segura a chamada à espera de mensagens (0 a 20). */
  waitSeconds: number;
  /** Mensagens por `ReceiveMessage` (1 a 10). */
  maxMessages: number;
  /** Handlers simultâneos neste processo. */
  concurrency: number;
  /** Quanto `stop()` espera os handlers em andamento antes de devolver as mensagens. */
  shutdownTimeoutMs: number;
}

// Pausa antes de tentar de novo depois de uma falha de recepção (SQS fora, fila ainda sem URL)
const RECEIVE_RETRY_DELAY_MS = 1000;

/**
 * Laço de consumo de uma fila SQS: long polling, concorrência limitada e parada graciosa.
 * Não decide o que fazer com cada mensagem; isso é do `QueueMessageHandler`.
 *
 * - **Ordem:** mensagens do mesmo `MessageGroupId` de um lote rodam em sequência; grupos
 *   distintos, em paralelo. É só uma cortesia: a correção financeira vem do banco, não da
 *   ordenação FIFO (README §5.3).
 * - **Backpressure:** só pede um novo lote quando há menos mensagens em andamento que a
 *   concorrência. Um lote pode, portanto, exceder a concorrência e aguardar vaga; a espera
 *   cabe na visibilidade da fila.
 * - **Parada:** `stop()` cancela o long polling, não inicia mais handlers, espera os que
 *   estão rodando até `shutdownTimeoutMs` e devolve à fila (`ChangeMessageVisibility(0)`) o que
 *   não começou ou estourou o prazo. Se o cancelamento pegar um `ReceiveMessage` já respondido
 *   pelo broker, essas mensagens reaparecem após a visibilidade; a inbox torna isso inofensivo.
 */
export class SqsMessagePoller {
  private stopping = false;
  private loop?: Promise<void>;
  private readonly abort = new AbortController();

  /** Tarefas por mensagem recebida (aguardando vaga ou rodando). Nunca rejeitam. */
  private readonly pending = new Set<Promise<void>>();
  private readonly running = new Set<QueueMessage>();
  private freeSlots: number;
  private readonly slotWaiters: Array<(granted: boolean) => void> = [];

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: SqsQueueUrlResolver,
    private readonly handler: QueueMessageHandler,
    private readonly acknowledger: MessageAcknowledger,
    private readonly logger: AppLogger,
    private readonly options: SqsMessagePollerOptions,
  ) {
    this.freeSlots = options.concurrency;
  }

  public start(): void {
    if (this.loop) {
      return;
    }
    this.logger.info("sqs consumer started", {
      waitSeconds: this.options.waitSeconds,
      maxMessages: this.options.maxMessages,
      concurrency: this.options.concurrency,
    });
    this.loop = this.run();
  }

  public async stop(): Promise<void> {
    if (!this.loop) {
      return;
    }
    this.stopping = true;
    this.abort.abort();
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter(false);
    }
    await this.loop;

    const timedOut = await this.drain();
    const overdue = [...this.running];
    for (const message of overdue) {
      await this.release(message, "shutdown timeout");
    }
    this.logger.info("sqs consumer stopped", { timedOut, overdue: overdue.length });
    this.loop = undefined;
  }

  // ---- Laço de recepção

  private async run(): Promise<void> {
    while (!this.stopping) {
      if (this.pending.size >= this.options.concurrency) {
        await Promise.race(this.pending);
        continue;
      }

      let messages: QueueMessage[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (this.stopping) {
          break;
        }
        this.logger.error("sqs receive failed", { error: describe(error) });
        await this.pause(RECEIVE_RETRY_DELAY_MS);
        continue;
      }
      this.dispatch(messages);
    }
  }

  private async receive(): Promise<QueueMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl.resolve(),
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitSeconds,
        // O parâmetro legado é o único que o LocalStack 3.4 honra para group id e receive count
        AttributeNames: ["All"],
      }),
      { abortSignal: this.abort.signal },
    );
    return (response.Messages ?? []).map(toQueueMessage);
  }

  /** Agrupa por `MessageGroupId`: cada grupo é uma cadeia sequencial; os grupos correm soltos. */
  private dispatch(messages: QueueMessage[]): void {
    const tails = new Map<string, Promise<void>>();
    for (const message of messages) {
      const key = message.groupId ?? message.id;
      const previous = tails.get(key) ?? Promise.resolve();
      const task = previous.then(() => this.process(message)).finally(() => this.pending.delete(task));
      tails.set(key, task);
      this.pending.add(task);
    }
  }

  private async process(message: QueueMessage): Promise<void> {
    if (!(await this.acquireSlot())) {
      await this.release(message, "consumer stopping");
      return;
    }
    this.running.add(message);
    try {
      await this.handler.handle(message);
    } catch (error) {
      // O handler não deveria lançar; se lançar, a mensagem reaparece após a visibilidade
      this.logger.error("sqs message handler failed unexpectedly", {
        sqsMessageId: message.id,
        error: describe(error),
      });
    } finally {
      this.running.delete(message);
      this.releaseSlot();
    }
  }

  // ---- Vagas de concorrência

  private acquireSlot(): Promise<boolean> {
    if (this.stopping) {
      return Promise.resolve(false);
    }
    if (this.freeSlots > 0) {
      this.freeSlots -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot(): void {
    const waiter = this.slotWaiters.shift();
    if (waiter) {
      waiter(true);
    } else {
      this.freeSlots += 1;
    }
  }

  // ---- Parada

  /** Espera as tarefas pendentes até o prazo; devolve true se estourou. */
  private async drain(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.options.shutdownTimeoutMs);
    });
    const finished = Promise.all([...this.pending]).then(() => false as const);
    try {
      return await Promise.race([finished, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async release(message: QueueMessage, reason: string): Promise<void> {
    try {
      await this.acknowledger.changeVisibility(message, 0);
      this.logger.info("sqs message returned to the queue", { sqsMessageId: message.id, reason });
    } catch (error) {
      // Sem devolução imediata a mensagem volta quando a visibilidade expirar
      this.logger.warn("sqs message could not be returned to the queue", {
        sqsMessageId: message.id,
        reason,
        error: describe(error),
      });
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", done, { once: true });
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

function toQueueMessage(message: Message): QueueMessage {
  return {
    id: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    ...(message.Attributes?.MessageGroupId !== undefined
      ? { groupId: message.Attributes.MessageGroupId }
      : {}),
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
