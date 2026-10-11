import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/shared/domain/money";
import {
  canonicalJson,
  computePayloadHash,
} from "../../../../src/wagering/domain/payload-hash";
import { WagerTransactionKind } from "../../../../src/wagering/domain/wager-transaction-types";


describe("Canonical JSON & Payload Hashing", () => {
  describe("canonicalJson", () => {
    it("should recursively sort keys alphabetically and format without whitespace", () => {
      const obj1 = { b: 2, a: 1, c: { z: 10, y: 20 } };
      const obj2 = { c: { y: 20, z: 10 }, a: 1, b: 2 };

      const json1 = canonicalJson(obj1);
      const json2 = canonicalJson(obj2);

      expect(json1).toBe('{"a":1,"b":2,"c":{"y":20,"z":10}}');
      expect(json1).toBe(json2);
    });

    it("should omit null and undefined properties in objects", () => {
      const objWithNulls = {
        a: "value",
        b: null,
        c: undefined,
        d: { innerNull: null, innerValid: 123 },
      };

      const result = canonicalJson(objWithNulls);
      expect(result).toBe('{"a":"value","d":{"innerValid":123}}');
    });

    it("should handle Money value object via toJSON()", () => {
      const money = Money.from({ amount: "25.00", currency: "BRL" });
      const result = canonicalJson({ money });

      expect(result).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    });

    it("should format arrays preserving order while canonizing elements", () => {
      const arr = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
      const result = canonicalJson(arr);

      expect(result).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
    });
  });

  describe("computePayloadHash", () => {
    const baseFields = {
      providerId: "provider-a",
      externalTransactionId: "ext-100",
      playerId: "player-100",
      walletId: "wallet-100",
      roundId: "round-100",
      gameId: "game-100",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
    };

    it("should generate the same hash regardless of object key definition order", () => {
      const hash1 = computePayloadHash({
        providerId: "provider-a",
        externalTransactionId: "ext-100",
        playerId: "player-100",
        walletId: "wallet-100",
        roundId: "round-100",
        gameId: "game-100",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      const hash2 = computePayloadHash({
        gameId: "game-100",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "50.00", currency: "BRL" }),
        roundId: "round-100",
        walletId: "wallet-100",
        playerId: "player-100",
        externalTransactionId: "ext-100",
        providerId: "provider-a",
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it("should treat null and undefined referenceExternalTransactionId identically", () => {
      const hashUndefined = computePayloadHash({
        ...baseFields,
        referenceExternalTransactionId: undefined,
      });

      const hashNull = computePayloadHash({
        ...baseFields,
        referenceExternalTransactionId: null,
      });

      const hashOmitted = computePayloadHash({
        ...baseFields,
      });

      expect(hashUndefined).toBe(hashNull);
      expect(hashUndefined).toBe(hashOmitted);
    });

    it("should produce different hash when any business field changes", () => {
      const originalHash = computePayloadHash(baseFields);

      const modifiedAmount = computePayloadHash({
        ...baseFields,
        money: Money.from({ amount: "50.01", currency: "BRL" }),
      });

      const modifiedCurrency = computePayloadHash({
        ...baseFields,
        money: Money.from({ amount: "50.00", currency: "USD" }),
      });

      const modifiedRound = computePayloadHash({
        ...baseFields,
        roundId: "round-101",
      });

      const withReference = computePayloadHash({
        ...baseFields,
        referenceExternalTransactionId: "ext-ref-1",
      });

      expect(modifiedAmount).not.toBe(originalHash);
      expect(modifiedCurrency).not.toBe(originalHash);
      expect(modifiedRound).not.toBe(originalHash);
      expect(withReference).not.toBe(originalHash);
    });

    it("should produce the exact same hash across different channels if payload content is identical", () => {
      // Cenário: requisição recebida via HTTP e posteriormente via SQS com mesmos campos de negócio
      const httpPayload = computePayloadHash({
        providerId: "provider-evolution",
        externalTransactionId: "evt-999",
        playerId: "ply-1",
        walletId: "wal-1",
        roundId: "rnd-55",
        gameId: "roulette-live",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      const sqsPayload = computePayloadHash({
        gameId: "roulette-live",
        providerId: "provider-evolution",
        walletId: "wal-1",
        money: Money.from({ amount: "100.00", currency: "BRL" }),
        externalTransactionId: "evt-999",
        playerId: "ply-1",
        kind: WagerTransactionKind.Bet,
        roundId: "rnd-55",
      });

      expect(httpPayload).toBe(sqsPayload);
    });
  });
});
