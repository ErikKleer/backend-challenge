import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { QueueMessage, QueueMessageHandler } from "../../../src/messaging/application/queue-message";
import { SqsMessageAcknowledger } from "../../../src/messaging/infrastructure/sqs/sqs-message-acknowledger";
import { SqsMessagePoller } from "../../../src/messaging/infrastructure/sqs/sqs-message-poller";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { WagerTransactionsConsumer } from "../../../src/wagering/infrastructure/sqs-consumer/wager-transactions-consumer";
import { waitFor } from "../../support/parallel";
import { createTestQueues, isQueueEmpty, sendMessage, type TestQueues } from "../../support/sqs";

let queues: TestQueues;
let app: INestApplicationContext | undefined;

beforeEach(async () => {
  queues = await createTestQueues({ visibilityTimeoutSeconds: 5 });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await queues.teardown();
});

async function bootConsumer(handler: QueueMessageHandler, enabled: boolean): Promise<INestApplicationContext> {
  const queueUrl = new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName);
  const poller = new SqsMessagePoller(
    queues.client,
    queueUrl,
    handler,
    new SqsMessageAcknowledger(queues.client, queueUrl),
    new AppLogger({ level: "silent" }),
    { waitSeconds: 1, maxMessages: 10, concurrency: 1, shutdownTimeoutMs: 5000 },
  );

  @Module({
    providers: [
      { provide: WagerTransactionsConsumer, useFactory: () => new WagerTransactionsConsumer(poller, enabled) },
    ],
  })
  class ConsumerTestModule {}

  const context = await NestFactory.createApplicationContext(ConsumerTestModule, { logger: false });
  await context.init();
  return context;
}

describe("WagerTransactionsConsumer lifecycle", () => {
  it("consumes after bootstrap and finishes the in-flight message when the application closes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const acknowledged: string[] = [];
    const acknowledger = new SqsMessageAcknowledger(
      queues.client,
      new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName),
    );
    const handler: QueueMessageHandler = {
      async handle(message: QueueMessage) {
        started += 1;
        await gate;
        await acknowledger.acknowledge(message);
        acknowledged.push(message.id);
      },
    };

    await sendMessage(queues.client, queues.transactionsUrl, "{}");
    app = await bootConsumer(handler, true);
    await waitFor(() => started === 1, { description: "message in flight" });

    const closing = app.close();
    app = undefined;
    release();
    await closing;

    // `close()` só retorna depois de o handler terminar e confirmar a mensagem
    expect(acknowledged).toHaveLength(1);
    await waitFor(() => isQueueEmpty(queues.client, queues.transactionsUrl), { description: "queue empty" });
  });
});
