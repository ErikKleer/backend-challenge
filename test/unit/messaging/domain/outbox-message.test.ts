import { describe, expect, it } from "bun:test";
import { deriveEventId } from "../../../../src/messaging/domain/event-id";
import { OutboxMessage } from "../../../../src/messaging/domain/outbox-message";
import { WalletBalanceChanged } from "../../../../src/messaging/domain/wallet-balance-changed.event";
import { InvalidMessageStateError } from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";
import { Wallet } from "../../../../src/wallet/domain/wallet";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const TX_ID = "0192f292-0000-7000-8000-000000000001";
const OCCURRED_AT = new Date("2026-07-29T15:00:00.000Z");

function newEvent(): WalletBalanceChanged {
  const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
  const wallet = Wallet.open({ id: WALLET_ID, playerId: "player-1", initialBalance: brl("100.00") });
  const entry = wallet.debit({
    entryId: "0192f292-0000-7000-8000-0000000000e1",
    transactionId: TX_ID,
    money: brl("25.00"),
    at: OCCURRED_AT,
  });
  return WalletBalanceChanged.from(wallet, entry, { correlationId: "corr-1", now: OCCURRED_AT });
}

const at = (secondsAfter: number) => new Date(OCCURRED_AT.getTime() + secondsAfter * 1000);

describe("OutboxMessage", () => {
  describe("enqueue", () => {
    it("should build a pending message from the event envelope", () => {
      const event = newEvent();

      const message = OutboxMessage.enqueue(event);

      expect(message.id).toBe(event.eventId);
      expect(message.id).toBe(deriveEventId(TX_ID, "WalletBalanceChanged"));
      expect(message.aggregateId).toBe(WALLET_ID);
      expect(message.eventType).toBe("WalletBalanceChanged");
      expect(message.occurredAt).toEqual(OCCURRED_AT);
      expect(message.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
      expect(message.attempts).toBe(0);
      expect(message.nextAttemptAt).toBeUndefined();
      expect(message.publishedAt).toBeUndefined();
      expect(message.isPending()).toBe(true);
    });
  });

  describe("isDue", () => {
    it("should be due from occurredAt when never attempted", () => {
      const message = OutboxMessage.enqueue(newEvent());

      expect(message.isDue(at(-1))).toBe(false);
      expect(message.isDue(at(0))).toBe(true);
      expect(message.isDue(at(10))).toBe(true);
    });

    it("should be due from nextAttemptAt after a retry is scheduled", () => {
      const message = OutboxMessage.enqueue(newEvent());
      message.scheduleRetry(at(5));

      expect(message.isDue(at(5))).toBe(false);
      expect(message.isDue(at(6))).toBe(true);
    });

    it("should never be due once published", () => {
      const message = OutboxMessage.enqueue(newEvent());
      message.markPublished(at(1));

      expect(message.isDue(at(100))).toBe(false);
    });
  });

  describe("markPublished", () => {
    it("should record publication and stop being pending", () => {
      const message = OutboxMessage.enqueue(newEvent());
      message.scheduleRetry(at(1));

      message.markPublished(at(3));

      expect(message.isPending()).toBe(false);
      expect(message.publishedAt).toEqual(at(3));
      expect(message.nextAttemptAt).toBeUndefined();
    });

    it("should reject publishing twice", () => {
      const message = OutboxMessage.enqueue(newEvent());
      message.markPublished(at(1));

      expect(() => message.markPublished(at(2))).toThrow(InvalidMessageStateError);
    });
  });

  describe("scheduleRetry", () => {
    it("should back off exponentially from 1s up to the 60s cap", () => {
      const message = OutboxMessage.enqueue(newEvent());
      const now = at(0);
      const delays: number[] = [];

      for (let i = 0; i < 9; i += 1) {
        message.scheduleRetry(now);
        delays.push((message.nextAttemptAt!.getTime() - now.getTime()) / 1000);
      }

      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
      expect(message.attempts).toBe(9);
    });

    it("should accept an injected policy", () => {
      const message = OutboxMessage.enqueue(newEvent());

      message.scheduleRetry(at(0), { baseDelayMs: 100, maxDelayMs: 250 });
      expect(message.nextAttemptAt).toEqual(new Date(OCCURRED_AT.getTime() + 100));
      message.scheduleRetry(at(0), { baseDelayMs: 100, maxDelayMs: 250 });
      expect(message.nextAttemptAt).toEqual(new Date(OCCURRED_AT.getTime() + 200));
      message.scheduleRetry(at(0), { baseDelayMs: 100, maxDelayMs: 250 });
      expect(message.nextAttemptAt).toEqual(new Date(OCCURRED_AT.getTime() + 250));
    });

    it("should keep retrying without an attempt limit and without overflow", () => {
      const message = OutboxMessage.rehydrate({
        id: deriveEventId(TX_ID, "WalletBalanceChanged"),
        aggregateId: WALLET_ID,
        eventType: "WalletBalanceChanged",
        payload: {},
        occurredAt: OCCURRED_AT,
        attempts: 10_000,
      });

      message.scheduleRetry(at(0));

      expect(message.attempts).toBe(10_001);
      expect(message.nextAttemptAt).toEqual(at(60));
    });

    it("should reject an invalid policy", () => {
      const message = OutboxMessage.enqueue(newEvent());

      expect(() => message.scheduleRetry(at(0), { baseDelayMs: 0, maxDelayMs: 10 })).toThrow(
        InvalidMessageStateError,
      );
      expect(() => message.scheduleRetry(at(0), { baseDelayMs: 100, maxDelayMs: 10 })).toThrow(
        InvalidMessageStateError,
      );
    });

    it("should reject scheduling a retry for a published message", () => {
      const message = OutboxMessage.enqueue(newEvent());
      message.markPublished(at(1));

      expect(() => message.scheduleRetry(at(2))).toThrow(InvalidMessageStateError);
    });
  });

  describe("rehydrate", () => {
    it("should restore persisted state without revalidating transitions", () => {
      const message = OutboxMessage.rehydrate({
        id: deriveEventId(TX_ID, "WalletBalanceChanged"),
        aggregateId: WALLET_ID,
        eventType: "WalletBalanceChanged",
        payload: { a: 1 },
        occurredAt: OCCURRED_AT,
        attempts: 3,
        nextAttemptAt: at(8),
        publishedAt: at(9),
      });

      expect(message.attempts).toBe(3);
      expect(message.nextAttemptAt).toEqual(at(8));
      expect(message.publishedAt).toEqual(at(9));
      expect(message.isPending()).toBe(false);
    });
  });
});
