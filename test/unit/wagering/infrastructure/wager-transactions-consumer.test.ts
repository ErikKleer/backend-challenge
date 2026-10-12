import { describe, expect, it } from "bun:test";
import type { SqsMessagePoller } from "../../../../src/messaging/infrastructure/sqs/sqs-message-poller";
import { WagerTransactionsConsumer } from "../../../../src/wagering/infrastructure/sqs-consumer/wager-transactions-consumer";

function fakePoller() {
  const calls: string[] = [];
  const poller = {
    start: () => calls.push("start"),
    stop: async () => {
      calls.push("stop");
    },
  } as unknown as SqsMessagePoller;
  return { poller, calls };
}

describe("WagerTransactionsConsumer", () => {
  it("starts the poller at bootstrap and stops it before the application shuts down", async () => {
    const { poller, calls } = fakePoller();
    const consumer = new WagerTransactionsConsumer(poller, true);

    consumer.onApplicationBootstrap();
    await consumer.beforeApplicationShutdown();

    expect(calls).toEqual(["start", "stop"]);
  });

  it("does not start consuming when the SQS consumer role is disabled", () => {
    const { poller, calls } = fakePoller();

    new WagerTransactionsConsumer(poller, false).onApplicationBootstrap();

    expect(calls).toEqual([]);
  });
});
