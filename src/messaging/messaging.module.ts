import { type DynamicModule, Module } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { FAULT_INJECTOR_TOKEN, type FaultInjector } from "../shared/application/fault-injector.port";
import { CLOCK_TOKEN, type Clock } from "../shared/application/clock.port";
import { UNIT_OF_WORK_TOKEN, type UnitOfWork } from "../shared/application/unit-of-work.port";
import { type EnvConfig, envSchema } from "../shared/infrastructure/config/env.config";
import { AppLogger } from "../shared/infrastructure/observability/app-logger";
import { MetricsService } from "../shared/infrastructure/observability/metrics.service";
import { EVENT_PUBLISHER_TOKEN, type EventPublisher } from "./application/event-publisher.port";
import { OutboxBatchPublisher } from "./application/outbox-batch-publisher";
import { OutboxPublisherWorker } from "./application/outbox-publisher.worker";
import { OUTBOX_REPOSITORY_TOKEN, type OutboxRepository } from "./application/outbox.repository.port";
import { SQS_READINESS_CHECK_TOKEN } from "../shared/application/readiness-check.port";
import { createSqsClient } from "./infrastructure/sqs/sqs-client.factory";
import { SqsEventPublisher } from "./infrastructure/sqs/sqs-event-publisher";
import { SqsReadinessCheck } from "./infrastructure/sqs/sqs-readiness-check";
import { SqsQueueUrlResolver } from "./infrastructure/sqs/sqs-queue-url.resolver";

const MESSAGING_CONFIG_TOKEN = Symbol("MessagingConfig");
const SQS_CLIENT_TOKEN = Symbol("SqsClient");
const OUTBOX_BATCH_PUBLISHER_TOKEN = Symbol("OutboxBatchPublisher");

/**
 * Papéis de mensageria do processo. A configuração é lida de forma preguiçosa (dentro das
 * factories), para que importar o módulo não exija o ambiente completo, como nos testes de API.
 *
 * É global só para expor o check de readiness do SQS ao `HealthModule`.
 */
@Module({})
export class MessagingModule {
  public static forRoot(): DynamicModule {
    return {
      module: MessagingModule,
      global: true,
      providers: [
        { provide: MESSAGING_CONFIG_TOKEN, useFactory: () => envSchema.parse(process.env) },
        {
          provide: SQS_CLIENT_TOKEN,
          useFactory: (config: EnvConfig) =>
            createSqsClient({
              region: config.AWS_REGION,
              endpoint: config.AWS_ENDPOINT,
              credentials: {
                accessKeyId: config.AWS_ACCESS_KEY_ID,
                secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
              },
              requestTimeoutMs: config.SQS_REQUEST_TIMEOUT_MS,
            }),
          inject: [MESSAGING_CONFIG_TOKEN],
        },
        {
          provide: EVENT_PUBLISHER_TOKEN,
          useFactory: async (client: SQSClient, config: EnvConfig, logger: AppLogger) => {
            const queueUrl = new SqsQueueUrlResolver(client, config.SQS_QUEUE_WAGER_EVENTS);
            // Aquece o cache no boot. Falha não derruba o processo: a fila pode ainda estar
            // sendo provisionada, e o primeiro publish tenta de novo (a falha não é cacheada)
            await queueUrl.resolve().catch((error: unknown) => {
              logger.warn("events queue not resolved at boot; will retry on first publish", {
                queue: config.SQS_QUEUE_WAGER_EVENTS,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            return new SqsEventPublisher(client, queueUrl);
          },
          inject: [SQS_CLIENT_TOKEN, MESSAGING_CONFIG_TOKEN, AppLogger],
        },
        {
          // Readiness sobre a fila de transações (a que o consumidor lê), com o cliente de timeout curto
          provide: SQS_READINESS_CHECK_TOKEN,
          useFactory: (client: SQSClient, config: EnvConfig) =>
            new SqsReadinessCheck(
              client,
              new SqsQueueUrlResolver(client, config.SQS_QUEUE_WAGER_TRANSACTIONS),
            ),
          inject: [SQS_CLIENT_TOKEN, MESSAGING_CONFIG_TOKEN],
        },
        {
          provide: OUTBOX_BATCH_PUBLISHER_TOKEN,
          useFactory: (
            unitOfWork: UnitOfWork,
            outbox: OutboxRepository,
            publisher: EventPublisher,
            clock: Clock,
            metrics: MetricsService,
            logger: AppLogger,
            config: EnvConfig,
            faults?: FaultInjector,
          ) =>
            new OutboxBatchPublisher(
              { unitOfWork, outbox, publisher, clock, metrics, logger, faults },
              { batchSize: config.OUTBOX_BATCH_SIZE },
            ),
          inject: [
            UNIT_OF_WORK_TOKEN,
            OUTBOX_REPOSITORY_TOKEN,
            EVENT_PUBLISHER_TOKEN,
            CLOCK_TOKEN,
            MetricsService,
            AppLogger,
            MESSAGING_CONFIG_TOKEN,
            { token: FAULT_INJECTOR_TOKEN, optional: true },
          ],
        },
        {
          provide: OutboxPublisherWorker,
          useFactory: (batchPublisher: OutboxBatchPublisher, logger: AppLogger, config: EnvConfig) =>
            new OutboxPublisherWorker(batchPublisher, logger, {
              enabled: config.ENABLE_OUTBOX_PUBLISHER,
              pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
              batchSize: config.OUTBOX_BATCH_SIZE,
            }),
          inject: [OUTBOX_BATCH_PUBLISHER_TOKEN, AppLogger, MESSAGING_CONFIG_TOKEN],
        },
      ],
      exports: [SQS_READINESS_CHECK_TOKEN],
    };
  }
}
