import { describe, expect, it } from "bun:test";
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InsufficientFundsError,
  WalletNotFoundError,
} from "../../../../src/shared/domain/domain.error";
import {
  LockTimeoutError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  WalletVersionConflictError,
} from "../../../../src/shared/infrastructure/persistence/postgres-errors";
import {
  classifyConsumerError,
  retryDelaySeconds,
} from "../../../../src/wagering/infrastructure/sqs-consumer/error-classification";
import { InvalidWagerMessageError } from "../../../../src/wagering/infrastructure/sqs-consumer/wager-transaction-message";

describe("classifyConsumerError", () => {
  it("acknowledges an idempotency conflict as a business outcome", () => {
    expect(classifyConsumerError(new IdempotencyConflictError("key reused")).category).toBe("business");
  });

  it.each([
    ["lock timeout", new LockTimeoutError()],
    ["version conflict", new WalletVersionConflictError()],
    ["deadlock", new TransientInfrastructureError("deadlock", "DEADLOCK_DETECTED")],
    ["connection failure", new TransientInfrastructureError("down", "CONNECTION_FAILURE")],
  ])("retries %s", (_name, error) => {
    expect(classifyConsumerError(error).category).toBe("transient");
  });

  it("retries an unknown error and leaves the limit to the redrive policy", () => {
    expect(classifyConsumerError(new Error("boom"))).toEqual({
      category: "transient",
      code: "UNEXPECTED_ERROR",
    });
  });

  it("sends a malformed message to the DLQ as an invalid message", () => {
    const classification = classifyConsumerError(new InvalidWagerMessageError("invalid_json", "bad"));

    expect(classification).toEqual({
      category: "permanent",
      code: "INVALID_JSON",
      dlqReason: "invalid_message",
    });
  });

  it.each([
    ["missing wallet", new WalletNotFoundError("w-1")],
    ["inbox hash mismatch", new InboxPayloadMismatchError("consumer", "msg-1")],
    ["other domain error", new InsufficientFundsError()],
    ["structural database error", new PermanentInfrastructureError("bad sql")],
  ])("sends %s to the DLQ as a permanent failure", (_name, error) => {
    const classification = classifyConsumerError(error);

    expect(classification.category).toBe("permanent");
    expect(classification.dlqReason).toBe("permanent_failure");
  });
});

describe("retryDelaySeconds", () => {
  it("doubles from the base on each delivery and stops at the cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((count) => retryDelaySeconds(count, 2, 60));

    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60]);
  });

  it("stays at the cap for absurd delivery counts", () => {
    expect(retryDelaySeconds(10_000, 2, 60)).toBe(60);
  });

  it("treats a missing or zero receive count as the first delivery", () => {
    expect(retryDelaySeconds(0, 2, 60)).toBe(2);
  });
});
