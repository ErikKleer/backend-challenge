import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MessageAcknowledger } from "../../../src/messaging/application/message-acknowledger.port";
import type { QueueMessage, QueueMessageHandler } from "../../../src/messaging/application/queue-message";
import { SqsMessageAcknowledger } from "../../../src/messaging/infrastructure/sqs/sqs-message-acknowledger";
import { SqsMessagePoller } from "../../../src/messaging/infrastructure/sqs/sqs-message-poller";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { waitFor } from "../../support/parallel";
import { createTestQueues, isQueueEmpty, sendMessage, type TestQueues } from "../../support/sqs";

let queues: TestQueues;
let acknowledger: MessageAcknowledger;

beforeEach(async () => {
  queues = await createTestQueues({ visibilityTimeoutSeconds: 5 });
  acknowledger = new SqsMessageAcknowledger(
    queues.client,
    new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName),
  );
});

afterEach(async () => {
  await queues.teardown();
});

function buildPoller(
  handler: QueueMessageHandler,
  options: { concurrency?: number; shutdownTimeoutMs?: number } = {},
): SqsMessagePoller {
  return new SqsMessagePoller(
    queues.client,
    new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName),
    handler,
    acknowledger,
    new AppLogger({ level: "silent" }),
    { waitSeconds: 1, maxMessages: 10, concurrency: options.concurrency ?? 4, shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000 },
  );
}

describe("SqsMessagePoller", () => {
  it("delivers every message to the handler and leaves the ack to it", async () => {
    const seen: string[] = [];
    const handler: QueueMessageHandler = {
      async handle(message: QueueMessage) {
        seen.push(JSON.parse(message.body).n);
        await acknowledger.acknowledge(message);
      },
    };
    const poller = buildPoller(handler);

    for (let n = 0; n < 12; n += 1) {
      await sendMessage(queues.client, queues.transactionsUrl, JSON.stringify({ n }), { groupId: `g${n % 3}` });
    }
    poller.start();
    await waitFor(() => seen.length === 12, { description: "12 messages handled" });
    await poller.stop();

    expect(new Set(seen).size).toBe(12);
    await waitFor(() => isQueueEmpty(queues.client, queues.transactionsUrl), { description: "queue empty" });
  });

  it("runs a group in order and never exceeds the configured concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const order: Record<string, number[]> = {};
    let handled = 0;
    const handler: QueueMessageHandler = {
      async handle(message: QueueMessage) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const { group, n } = JSON.parse(message.body) as { group: string; n: number };
        (order[group] ??= []).push(n);
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        active -= 1;
        handled += 1;
        await acknowledger.acknowledge(message);
      },
    };
    const poller = buildPoller(handler, { concurrency: 2 });

    for (const group of ["a", "b", "c"]) {
      for (let n = 0; n < 4; n += 1) {
        await sendMessage(queues.client, queues.transactionsUrl, JSON.stringify({ group, n }), { groupId: group });
      }
    }
    poller.start();
    await waitFor(() => handled === 12, { description: "all messages handled" });
    await poller.stop();

    expect(maxActive).toBeLessThanOrEqual(2);
    for (const group of ["a", "b", "c"]) {
      expect(order[group]).toEqual([0, 1, 2, 3]);
    }
  });

  it("redelivers a message that the handler did not acknowledge", async () => {
    const receiveCounts: number[] = [];
    const handler: QueueMessageHandler = {
      async handle(message: QueueMessage) {
        receiveCounts.push(message.receiveCount);
        if (message.receiveCount >= 2) {
          await acknowledger.acknowledge(message);
        } else {
          await acknowledger.changeVisibility(message, 1);
        }
      },
    };
    const poller = buildPoller(handler);

    await sendMessage(queues.client, queues.transactionsUrl, "{}");
    poller.start();
    await waitFor(() => receiveCounts.length >= 2, { description: "redelivery" });
    await poller.stop();

    expect(receiveCounts.slice(0, 2)).toEqual([1, 2]);
  });
});
