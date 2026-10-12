import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomBytes } from "node:crypto";
import { provisionQueues } from "../../src/messaging/infrastructure/queue-provisioning";
import { createSqsClient } from "../../src/messaging/infrastructure/sqs/sqs-client.factory";

export const TEST_SQS_ENDPOINT = process.env.AWS_ENDPOINT ?? "http://localhost:4566";
const TEST_CREDENTIALS = { accessKeyId: "dummy", secretAccessKey: "dummy" };
const TEST_REGION = process.env.AWS_REGION ?? "us-east-1";

export interface TestQueues {
  client: SQSClient;
  /** Nome da fila de eventos (com prefixo único), como o publisher a resolve. */
  eventsQueueName: string;
  eventsUrl: string;
  /** Nome da fila de transações (com prefixo único), como o consumidor a resolve. */
  transactionsQueueName: string;
  transactionsUrl: string;
  /** Nome da DLQ (com prefixo único). */
  dlqQueueName: string;
  dlqUrl: string;
  teardown: () => Promise<void>;
}

export interface ReceivedMessage {
  body: string;
  groupId: string | undefined;
  deduplicationId: string | undefined;
}

/**
 * Provisiona um trio de filas com prefixo aleatório no LocalStack real: cada suíte tem as
 * suas, então o conteúdo de uma nunca aparece em outra e não há limpeza entre suítes.
 */
export interface TestQueuesOptions {
  /** Default 5s: uma mensagem recebida e não apagada reaparece rápido. */
  visibilityTimeoutSeconds?: number;
  /** Entregas antes de a redrive policy mandar a mensagem para a DLQ (default do provisionamento). */
  maxReceiveCount?: number;
}

export async function createTestQueues(options: TestQueuesOptions = {}): Promise<TestQueues> {
  const prefix = `t${randomBytes(5).toString("hex")}-`;
  const provisioned = await provisionQueues({
    endpoint: TEST_SQS_ENDPOINT,
    region: TEST_REGION,
    credentials: TEST_CREDENTIALS,
    prefix,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 5,
    ...(options.maxReceiveCount !== undefined ? { maxReceiveCount: options.maxReceiveCount } : {}),
  });
  const client = createSqsClient({
    region: TEST_REGION,
    endpoint: TEST_SQS_ENDPOINT,
    credentials: TEST_CREDENTIALS,
    requestTimeoutMs: 5000,
  });

  return {
    client,
    eventsQueueName: `${prefix}wager-events.fifo`,
    eventsUrl: provisioned.eventsUrl,
    transactionsQueueName: `${prefix}wager-transactions.fifo`,
    dlqQueueName: `${prefix}wager-transactions-dlq.fifo`,
    transactionsUrl: provisioned.transactionsUrl,
    dlqUrl: provisioned.dlqUrl,
    teardown: async () => {
      for (const url of [provisioned.eventsUrl, provisioned.transactionsUrl, provisioned.dlqUrl]) {
        await client.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
      client.destroy();
    },
  };
}

/**
 * Lê (e apaga) tudo o que há na fila até `isDone(todas as recebidas)` ser verdadeiro ou o
 * tempo acabar. Apagar é necessário no FIFO: uma mensagem em voo bloqueia as seguintes do
 * mesmo grupo. Devolve tudo o que recebeu; quem chama decide se faltou algo.
 */
export async function receiveUntil(
  client: SQSClient,
  queueUrl: string,
  isDone: (received: ReceivedMessage[]) => boolean,
  timeoutMs = 15_000,
): Promise<ReceivedMessage[]> {
  const received: ReceivedMessage[] = [];
  const deadline = Date.now() + timeoutMs;

  while (!isDone(received) && Date.now() < deadline) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        // O LocalStack 3.4 só devolve group/dedup id pelo parâmetro legado AttributeNames
        AttributeNames: ["All"],
      }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      continue;
    }
    for (const message of messages) {
      received.push({
        body: message.Body ?? "",
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
      });
    }
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle!,
        })),
      }),
    );
  }

  return received;
}

/** `eventId` de cada mensagem recebida, na ordem de chegada (com repetições, se houver). */
export function eventIdsOf(received: ReceivedMessage[]): string[] {
  return received.map((message) => (JSON.parse(message.body) as { eventId: string }).eventId);
}

/** Envia uma mensagem à fila (FIFO). A deduplicação do broker só se evita com `deduplicationId` distinto. */
export async function sendMessage(
  client: SQSClient,
  queueUrl: string,
  body: string,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId ?? "group-default",
      MessageDeduplicationId: options.deduplicationId ?? randomBytes(12).toString("hex"),
    }),
  );
}

export interface QueueCounts {
  visible: number;
  inFlight: number;
  delayed: number;
}

/** Contagens aproximadas do broker; "vazia" é `visible + inFlight + delayed === 0`. */
export async function queueCounts(client: SQSClient, queueUrl: string): Promise<QueueCounts> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

export async function isQueueEmpty(client: SQSClient, queueUrl: string): Promise<boolean> {
  const counts = await queueCounts(client, queueUrl);
  return counts.visible + counts.inFlight + counts.delayed === 0;
}
