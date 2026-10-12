import { type DynamicModule, Module } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  DEAD_LETTER_PUBLISHER_TOKEN,
  type DeadLetterPublisher,
} from "../../../messaging/application/dead-letter-publisher.port";
import {
  MESSAGE_ACKNOWLEDGER_TOKEN,
  type MessageAcknowledger,
} from "../../../messaging/application/message-acknowledger.port";
import { createSqsClient } from "../../../messaging/infrastructure/sqs/sqs-client.factory";
import { SqsDeadLetterPublisher } from "../../../messaging/infrastructure/sqs/sqs-dead-letter-publisher";
import { SqsMessageAcknowledger } from "../../../messaging/infrastructure/sqs/sqs-message-acknowledger";
import { SqsMessagePoller } from "../../../messaging/infrastructure/sqs/sqs-message-poller";
import { SqsQueueUrlResolver } from "../../../messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { type EnvConfig, envSchema } from "../../../shared/infrastructure/config/env.config";
import { AppLogger } from "../../../shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../../shared/infrastructure/observability/metrics.service";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { WageringModule } from "../../wagering.module";
import { WagerTransactionMessageHandler } from "./wager-transaction-message.handler";
import { WagerTransactionsConsumer } from "./wager-transactions-consumer";

const CONSUMER_CONFIG_TOKEN = Symbol("WagerTransactionsConsumerConfig");
const CONSUMER_SQS_CLIENT_TOKEN = Symbol("WagerTransactionsConsumerSqsClient");
const TRANSACTIONS_QUEUE_URL_TOKEN = Symbol("WagerTransactionsQueueUrl");
const DLQ_URL_TOKEN = Symbol("WagerTransactionsDlqUrl");
const MESSAGE_HANDLER_TOKEN = Symbol("WagerTransactionMessageHandler");
const POLLER_TOKEN = Symbol("WagerTransactionsPoller");

// Folga sobre o long polling: a chamada precisa durar mais que `WaitTimeSeconds`
const LONG_POLL_REQUEST_MARGIN_MS = 5000;

/**
 * Papel de consumidor SQS. A configuração é lida de forma preguiçosa (dentro das factories),
 * como no `MessagingModule`, para que importar o módulo não exija o ambiente completo.
 */
@Module({})
export class WagerTransactionsConsumerModule {
  public static forRoot(): DynamicModule {
    return {
      module: WagerTransactionsConsumerModule,
      imports: [WageringModule],
      providers: [
        { provide: CONSUMER_CONFIG_TOKEN, useFactory: () => envSchema.parse(process.env) },
        {
          // Cliente próprio: o do outbox tem timeout curto, incompatível com o long polling
          provide: CONSUMER_SQS_CLIENT_TOKEN,
          useFactory: (config: EnvConfig) =>
            createSqsClient({
              region: config.AWS_REGION,
              endpoint: config.AWS_ENDPOINT,
              credentials: {
                accessKeyId: config.AWS_ACCESS_KEY_ID,
                secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
              },
              requestTimeoutMs: config.SQS_WAIT_SECONDS * 1000 + LONG_POLL_REQUEST_MARGIN_MS,
            }),
          inject: [CONSUMER_CONFIG_TOKEN],
        },
        {
          provide: TRANSACTIONS_QUEUE_URL_TOKEN,
          useFactory: (client: SQSClient, config: EnvConfig) =>
            new SqsQueueUrlResolver(client, config.SQS_QUEUE_WAGER_TRANSACTIONS),
          inject: [CONSUMER_SQS_CLIENT_TOKEN, CONSUMER_CONFIG_TOKEN],
        },
        {
          provide: MESSAGE_ACKNOWLEDGER_TOKEN,
          useFactory: (client: SQSClient, queueUrl: SqsQueueUrlResolver) =>
            new SqsMessageAcknowledger(client, queueUrl),
          inject: [CONSUMER_SQS_CLIENT_TOKEN, TRANSACTIONS_QUEUE_URL_TOKEN],
        },
        {
          provide: DLQ_URL_TOKEN,
          useFactory: (client: SQSClient, config: EnvConfig) =>
            new SqsQueueUrlResolver(client, config.SQS_QUEUE_WAGER_TRANSACTIONS_DLQ),
          inject: [CONSUMER_SQS_CLIENT_TOKEN, CONSUMER_CONFIG_TOKEN],
        },
        {
          provide: DEAD_LETTER_PUBLISHER_TOKEN,
          useFactory: (client: SQSClient, queueUrl: SqsQueueUrlResolver) =>
            new SqsDeadLetterPublisher(client, queueUrl),
          inject: [CONSUMER_SQS_CLIENT_TOKEN, DLQ_URL_TOKEN],
        },
        {
          provide: MESSAGE_HANDLER_TOKEN,
          useFactory: (
            useCase: SubmitWagerTransactionUseCase,
            acknowledger: MessageAcknowledger,
            deadLetters: DeadLetterPublisher,
            logger: AppLogger,
            metrics: MetricsService,
            config: EnvConfig,
          ) =>
            new WagerTransactionMessageHandler(useCase, acknowledger, deadLetters, logger, metrics, {
              retryBaseSeconds: config.SQS_RETRY_BASE_SECONDS,
              retryMaxSeconds: config.SQS_RETRY_MAX_SECONDS,
              maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
            }),
          inject: [
            SubmitWagerTransactionUseCase,
            MESSAGE_ACKNOWLEDGER_TOKEN,
            DEAD_LETTER_PUBLISHER_TOKEN,
            AppLogger,
            MetricsService,
            CONSUMER_CONFIG_TOKEN,
          ],
        },
        {
          provide: POLLER_TOKEN,
          useFactory: (
            client: SQSClient,
            queueUrl: SqsQueueUrlResolver,
            handler: WagerTransactionMessageHandler,
            acknowledger: MessageAcknowledger,
            logger: AppLogger,
            config: EnvConfig,
          ) =>
            new SqsMessagePoller(client, queueUrl, handler, acknowledger, logger, {
              waitSeconds: config.SQS_WAIT_SECONDS,
              maxMessages: config.SQS_MAX_MESSAGES,
              concurrency: config.SQS_CONSUMER_CONCURRENCY,
              shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
            }),
          inject: [
            CONSUMER_SQS_CLIENT_TOKEN,
            TRANSACTIONS_QUEUE_URL_TOKEN,
            MESSAGE_HANDLER_TOKEN,
            MESSAGE_ACKNOWLEDGER_TOKEN,
            AppLogger,
            CONSUMER_CONFIG_TOKEN,
          ],
        },
        {
          provide: WagerTransactionsConsumer,
          useFactory: (poller: SqsMessagePoller, config: EnvConfig) =>
            new WagerTransactionsConsumer(poller, config.ENABLE_SQS_CONSUMER),
          inject: [POLLER_TOKEN, CONSUMER_CONFIG_TOKEN],
        },
      ],
    };
  }
}
