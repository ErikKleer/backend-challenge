import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/shared/domain/money";
import type { SubmitWagerTransactionResult } from "../../../../src/wagering/application/submit-wager-transaction.command";
import { httpStatusFor } from "../../../../src/wagering/presentation/wager-http-status";
import {
  FailureCode,
  WagerTransactionStatus,
} from "../../../../src/wagering/domain/wager-transaction-types";

function result(
  status: WagerTransactionStatus,
  idempotentReplay: boolean,
): SubmitWagerTransactionResult {
  return {
    transactionId: "tx",
    status,
    balance: Money.zero("BRL"),
    idempotentReplay,
    ...(status === WagerTransactionStatus.Rejected ? { failureCode: FailureCode.InsufficientFunds } : {}),
  };
}

describe("httpStatusFor", () => {
  const cases: Array<[WagerTransactionStatus, boolean, number]> = [
    [WagerTransactionStatus.Processed, false, 201],
    [WagerTransactionStatus.Processed, true, 200],
    [WagerTransactionStatus.PendingReference, false, 202],
    [WagerTransactionStatus.PendingReference, true, 202],
    [WagerTransactionStatus.Rejected, false, 422],
    [WagerTransactionStatus.Rejected, true, 422],
    [WagerTransactionStatus.Failed, true, 422],
  ];
  for (const [status, replay, expected] of cases) {
    it(`maps ${status} (replay: ${replay}) to ${expected}`, () => {
      expect(httpStatusFor(result(status, replay))).toBe(expected);
    });
  }
});
