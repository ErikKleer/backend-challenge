import { describe, expect, it } from "bun:test";
import { WagerTransactionKind } from "../../../../src/wagering/domain/wager-transaction-types";
import {
  InvalidWagerMessageError,
  parseWagerTransactionMessage,
} from "../../../../src/wagering/infrastructure/sqs-consumer/wager-transaction-message";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

function validEnvelope(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: "provider-a:transaction-123",
      playerId: "player-1",
      walletId: WALLET_ID,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...data,
    },
    ...overrides,
  };
}

function parse(envelope: unknown) {
  return parseWagerTransactionMessage(JSON.stringify(envelope));
}

function reasonOf(body: string): string | undefined {
  try {
    parseWagerTransactionMessage(body);
  } catch (error) {
    return error instanceof InvalidWagerMessageError ? error.reason : "other";
  }
  return undefined;
}

describe("parseWagerTransactionMessage", () => {
  it("builds the command from the README message, keeping money as Money", () => {
    const message = parse(validEnvelope());

    expect(message.messageId).toBe("msg-123");
    expect(message.occurredAt.toISOString()).toBe("2026-07-29T15:00:00.000Z");
    expect(message.command.idempotencyKey).toBe("provider-a:transaction-123");
    expect(message.command.kind).toBe(WagerTransactionKind.Bet);
    expect(message.command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("rejects a body that is not JSON", () => {
    expect(reasonOf("{not json")).toBe("invalid_json");
  });

  it("rejects an envelope without messageId", () => {
    const { messageId: _omitted, ...rest } = validEnvelope();
    expect(reasonOf(JSON.stringify(rest))).toBe("invalid_envelope");
  });

  it("rejects an occurredAt that is not a timestamp", () => {
    expect(reasonOf(JSON.stringify(validEnvelope({ occurredAt: "yesterday" })))).toBe("invalid_envelope");
  });

  it("rejects an unknown type before looking at the data", () => {
    expect(reasonOf(JSON.stringify(validEnvelope({ type: "SomethingElse", data: 42 })))).toBe("unknown_type");
  });

  it("rejects OPENING, which is internal and never submittable", () => {
    expect(reasonOf(JSON.stringify(validEnvelope({}, { kind: "OPENING" })))).toBe("invalid_data");
  });

  it("rejects a REFUND without a reference", () => {
    expect(reasonOf(JSON.stringify(validEnvelope({}, { kind: "REFUND" })))).toBe("invalid_data");
  });

  it("rejects a missing idempotencyKey and an amount with the wrong scale", () => {
    const { idempotencyKey: _omitted, ...withoutKey } = validEnvelope().data;
    expect(reasonOf(JSON.stringify(validEnvelope({ data: withoutKey })))).toBe("invalid_data");
    expect(reasonOf(JSON.stringify(validEnvelope({}, { money: { amount: "25.5", currency: "BRL" } })))).toBe(
      "invalid_data",
    );
  });
});
