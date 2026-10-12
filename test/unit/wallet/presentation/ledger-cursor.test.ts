import { describe, expect, it } from "bun:test";
import { RequestValidationError } from "../../../../src/shared/presentation/request-validation.error";
import {
  DEFAULT_LEDGER_PAGE_SIZE,
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from "../../../../src/wallet/presentation/ledger-cursor";

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

describe("ledger cursor", () => {
  it("round-trips the wallet version as opaque base64url", () => {
    const cursor = encodeLedgerCursor(42);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual({ v: 1, wv: 42 });
    expect(decodeLedgerCursor(cursor)).toBe(42);
  });

  it.each([
    ["garbage", "not-a-cursor!!"],
    ["non JSON", b64("hello")],
    ["unknown version", b64(JSON.stringify({ v: 2, wv: 1 }))],
    ["missing wv", b64(JSON.stringify({ v: 1 }))],
    ["fractional wv", b64(JSON.stringify({ v: 1, wv: 1.5 }))],
    ["negative wv", b64(JSON.stringify({ v: 1, wv: -1 }))],
    ["string wv", b64(JSON.stringify({ v: 1, wv: "3" }))],
    ["null payload", b64("null")],
  ])("rejects an invalid cursor: %s", (_label, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(RequestValidationError);
  });
});

describe("ledger limit", () => {
  it("defaults to 50 and accepts 1..200", () => {
    expect(parseLedgerLimit(undefined)).toBe(DEFAULT_LEDGER_PAGE_SIZE);
    expect(parseLedgerLimit("1")).toBe(1);
    expect(parseLedgerLimit("200")).toBe(200);
  });

  it.each(["0", "201", "-1", "1.5", "abc", "", "007"])("rejects limit %p", (raw) => {
    expect(() => parseLedgerLimit(raw)).toThrow(RequestValidationError);
  });
});
