import { describe, it, expect } from "bun:test";
import {
  REDACTED,
  redactSensitive,
} from "../../../../src/shared/infrastructure/observability/redaction";

describe("redactSensitive", () => {
  it("redacts sensitive keys at any depth, ignoring case", () => {
    const result = redactSensitive({
      status: "PROCESSED",
      Authorization: "Bearer abc",
      amount: "10.00",
      nested: { money: { amount: "1.00" }, payload: { a: 1 }, walletId: "w-1" },
      list: [{ observedBalance: "5.00", ok: true }],
      balanceAfter: "9.00",
    });

    expect(result).toEqual({
      status: "PROCESSED",
      Authorization: REDACTED,
      amount: REDACTED,
      nested: { money: REDACTED, payload: REDACTED, walletId: "w-1" },
      list: [{ observedBalance: REDACTED, ok: true }],
      balanceAfter: REDACTED,
    });
  });

  it("does not mutate the input", () => {
    const input = { amount: "10.00", inner: { payload: "x" } };
    redactSensitive(input);
    expect(input).toEqual({ amount: "10.00", inner: { payload: "x" } });
  });

  it("leaves errors and dates untouched", () => {
    const err = new Error("boom");
    const date = new Date();
    const result = redactSensitive({ err, date }) as Record<string, unknown>;
    expect(result.err).toBe(err);
    expect(result.date).toBe(date);
  });

  it("survives circular references", () => {
    const circular: Record<string, unknown> = { id: "x" };
    circular.self = circular;
    expect(() => redactSensitive(circular)).not.toThrow();
  });
});
