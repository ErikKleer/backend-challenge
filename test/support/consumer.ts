import type { MessageAcknowledger } from "../../src/messaging/application/message-acknowledger.port";
import { SqsMessageAcknowledger } from "../../src/messaging/infrastructure/sqs/sqs-message-acknowledger";
import { SqsMessagePoller } from "../../src/messaging/infrastructure/sqs/sqs-message-poller";
import { SqsQueueUrlResolver } from "../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import type { SubmitWagerTransactionCommand } from "../../src/wagering/application/submit-wager-transaction.command";
import type { SubmitWagerTransactionUseCase } from "../../src/wagering/application/submit-wager-transaction.use-case";
import { WagerTransactionMessageHandler } from "../../src/wagering/infrastructure/sqs-consumer/wager-transaction-message.handler";
import { AppLogger } from "../../src/shared/infrastructure/observability/app-logger";
import type { MetricsService } from "../../src/shared/infrastructure/observability/metrics.service";
import type { PersistenceTestContext } from "./persistence";
import { sendMessage, type TestQueues } from "./sqs";
import { WageringHarness, type WageringHarnessOverrides, type WalletFixture } from "./wagering";

export interface ConsumerRigOptions {
  /** Wrappers com falha injetada em volta do ledger/outbox reais usados pelo use case. */
  overrides?: WageringHarnessOverrides;
  /** Falha injetada em volta do use case real (por exemplo, erro transitório nas N primeiras). */
  useCase?: (real: SubmitWagerTransactionUseCase) => Pick<SubmitWagerTransactionUseCase, "execute">;
  /** Falha injetada em volta do acknowledger SQS real. */
  acknowledger?: (real: MessageAcknowledger) => MessageAcknowledger;
  concurrency?: number;
  shutdownTimeoutMs?: number;
}

export interface ConsumerRig {
  harness: WageringHarness;
  acknowledger: MessageAcknowledger;
  poller: SqsMessagePoller;
  handler: WagerTransactionMessageHandler;
  metrics: MetricsService;
}

/**
 * Monta o consumidor real (poller + handler + use case) sobre PostgreSQL e as filas do
 * LocalStack de `queues`. As opções só aceitam wrappers em volta de componentes reais.
 */
export function buildConsumerRig(
  ctx: PersistenceTestContext,
  queues: TestQueues,
  options: ConsumerRigOptions = {},
): ConsumerRig {
  const harness = new WageringHarness(ctx, options.overrides);
  const logger = new AppLogger({ level: "silent" });
  const queueUrl = new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName);
  const realAcknowledger = new SqsMessageAcknowledger(queues.client, queueUrl);
  const acknowledger = options.acknowledger?.(realAcknowledger) ?? realAcknowledger;
  const useCase = options.useCase?.(harness.useCase) ?? harness.useCase;

  const handler = new WagerTransactionMessageHandler(useCase, acknowledger, logger, harness.metrics, {
    // Backoff mínimo (inteiro de segundos exigido pelo SQS) para os testes terminarem rápido
    retryBaseSeconds: 1,
    retryMaxSeconds: 1,
    maxReceiveCount: queues.maxReceiveCount,
  });
  const poller = new SqsMessagePoller(queues.client, queueUrl, handler, acknowledger, logger, {
    waitSeconds: 1,
    maxMessages: 10,
    concurrency: options.concurrency ?? 4,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000,
  });
  return { harness, acknowledger, poller, handler, metrics: harness.metrics };
}

/** Corpo da mensagem `WagerTransactionRequested` (README §10) para um comando. */
export function wagerMessageBody(command: SubmitWagerTransactionCommand, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
      ...(command.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: command.referenceExternalTransactionId }
        : {}),
    },
  });
}

/**
 * Envia o comando à fila. `deduplicationId` distinto por envio contorna a deduplicação do FIFO
 * para simular o redelivery com o mesmo `messageId`.
 */
export async function sendWagerMessage(
  queues: TestQueues,
  wallet: WalletFixture,
  command: SubmitWagerTransactionCommand,
  messageId: string,
  options: { deduplicationId?: string } = {},
): Promise<void> {
  await sendMessage(queues.client, queues.transactionsUrl, wagerMessageBody(command, messageId), {
    groupId: wallet.walletId,
    ...(options.deduplicationId !== undefined ? { deduplicationId: options.deduplicationId } : {}),
  });
}

/** Valor de um contador do `MetricsService` para um conjunto exato de rótulos (0 se nunca incrementado). */
export async function counterValue(
  metrics: MetricsService,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) {
    throw new Error(`Unknown metric '${name}'`);
  }
  const { values } = await metric.get();
  const match = values.find((entry) =>
    Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
  );
  return match?.value ?? 0;
}
