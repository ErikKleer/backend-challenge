import { describe, expect, it } from "bun:test";
import { envSchema } from "../../../../src/shared/infrastructure/config/env.config";

const BASE_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/wagering_db",
  SQS_QUEUE_WAGER_TRANSACTIONS: "wager-transactions.fifo",
  SQS_QUEUE_WAGER_TRANSACTIONS_DLQ: "wager-transactions-dlq.fifo",
  SQS_QUEUE_WAGER_EVENTS: "wager-events.fifo",
};

describe("envSchema role flags", () => {
  it("enables every role by default", () => {
    const config = envSchema.parse(BASE_ENV);

    expect(config.ENABLE_HTTP).toBe(true);
    expect(config.ENABLE_OUTBOX_PUBLISHER).toBe(true);
    expect(config.OUTBOX_BATCH_SIZE).toBe(10);
  });

  it.each(["false", "FALSE", "0", "no", "off", ""])("treats '%s' as disabled", (value) => {
    const config = envSchema.parse({ ...BASE_ENV, ENABLE_OUTBOX_PUBLISHER: value });

    expect(config.ENABLE_OUTBOX_PUBLISHER).toBe(false);
  });

  it.each(["true", "1", "yes"])("treats '%s' as enabled", (value) => {
    const config = envSchema.parse({ ...BASE_ENV, ENABLE_OUTBOX_PUBLISHER: value });

    expect(config.ENABLE_OUTBOX_PUBLISHER).toBe(true);
  });
});
