import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message";
import { SqsEventPublisher } from "../../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { UuidV7IdGenerator } from "../../../src/shared/infrastructure/id/uuid-v7-id-generator";
import { createTestQueues, receiveUntil, type TestQueues } from "../../support/sqs";

const ids = new UuidV7IdGenerator();

let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues.teardown();
});

function outboxMessage(aggregateId = ids.generate()): OutboxMessage {
  const eventId = ids.generate();
  return OutboxMessage.rehydrate({
    id: eventId,
    aggregateId,
    eventType: "WalletBalanceChanged",
    payload: { eventId, eventType: "WalletBalanceChanged", aggregateId, version: 1, data: { n: 1 } },
    occurredAt: new Date("2026-07-29T15:00:00.000Z"),
    attempts: 0,
  });
}

describe("SqsEventPublisher", () => {
  it("sends the outbox envelope with the aggregate as group and the event id as deduplication id", async () => {
    const publisher = new SqsEventPublisher(
      queues.client,
      new SqsQueueUrlResolver(queues.client, queues.eventsQueueName),
    );
    const message = outboxMessage();

    await publisher.publish(message);

    const received = await receiveUntil(queues.client, queues.eventsUrl, (all) => all.length >= 1);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toEqual(message.payload);
    expect(received[0]!.groupId).toBe(message.aggregateId);
    expect(received[0]!.deduplicationId).toBe(message.id);
  });

  it("looks the queue URL up once and reuses it", async () => {
    let lookups = 0;
    const send = queues.client.send.bind(queues.client) as (command: unknown) => Promise<unknown>;
    const countingClient = {
      send: (command: unknown) => {
        if (command instanceof GetQueueUrlCommand) {
          lookups += 1;
        }
        return send(command);
      },
    } as unknown as typeof queues.client;
    const resolver = new SqsQueueUrlResolver(countingClient, queues.eventsQueueName);

    const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);
    const third = await resolver.resolve();

    expect(first).toBe(queues.eventsUrl);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(lookups).toBe(1);
  });

  it("rejects when the queue does not exist and does not cache the failure", async () => {
    const resolver = new SqsQueueUrlResolver(queues.client, `${queues.eventsQueueName}-missing.fifo`);
    const publisher = new SqsEventPublisher(queues.client, resolver);

    await expect(publisher.publish(outboxMessage())).rejects.toThrow();
    await expect(publisher.publish(outboxMessage())).rejects.toThrow();
  });
});
