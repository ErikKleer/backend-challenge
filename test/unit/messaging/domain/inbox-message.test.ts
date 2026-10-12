import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../../src/messaging/domain/inbox-message";
import { InvalidMessageStateError } from "../../../../src/shared/domain/domain.error";

const RECEIVED_AT = new Date("2026-07-29T15:00:00.000Z");
const props = {
  messageId: "msg-123",
  consumerName: "wager-transactions",
  payloadHash: "a".repeat(64),
  receivedAt: RECEIVED_AT,
};

describe("InboxMessage", () => {
  it("should be received unprocessed", () => {
    const message = InboxMessage.receive(props);

    expect(message.messageId).toBe("msg-123");
    expect(message.consumerName).toBe("wager-transactions");
    expect(message.payloadHash).toBe("a".repeat(64));
    expect(message.receivedAt).toEqual(RECEIVED_AT);
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });

  it("should record processing time", () => {
    const message = InboxMessage.receive(props);
    const processedAt = new Date("2026-07-29T15:00:01.000Z");

    message.markProcessed(processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  it("should reject processing twice", () => {
    const message = InboxMessage.receive(props);
    message.markProcessed(RECEIVED_AT);

    expect(() => message.markProcessed(RECEIVED_AT)).toThrow(InvalidMessageStateError);
  });

  it("should reject empty identifiers and malformed payload hashes", () => {
    expect(() => InboxMessage.receive({ ...props, messageId: "" })).toThrow(InvalidMessageStateError);
    expect(() => InboxMessage.receive({ ...props, consumerName: "" })).toThrow(
      InvalidMessageStateError,
    );
    expect(() => InboxMessage.receive({ ...props, payloadHash: "abc" })).toThrow(
      InvalidMessageStateError,
    );
    expect(() => InboxMessage.receive({ ...props, payloadHash: "A".repeat(64) })).toThrow(
      InvalidMessageStateError,
    );
  });

  it("should rehydrate persisted state", () => {
    const processedAt = new Date("2026-07-29T15:00:05.000Z");

    const message = InboxMessage.rehydrate({ ...props, processedAt });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });
});
