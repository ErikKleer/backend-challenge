import { describe, expect, it } from "bun:test";
import {
  InvalidTransactionStateError,
} from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";
import { LedgerDirection } from "../../../../src/wallet/domain/wallet-ledger-entry";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../../src/wagering/domain/wager-transaction-types";
import { WagerTransaction } from "../../../../src/wagering/domain/wager-transaction";

describe("WagerTransaction Aggregate and State Machine", () => {
  const createValidProps = (overrides?: Partial<Parameters<typeof WagerTransaction.create>[0]>) => ({
    id: "tx-100",
    providerId: "provider-a",
    externalTransactionId: "ext-100",
    idempotencyKey: "provider-a:ext-100",
    payloadHash: "hash-1234",
    walletId: "wallet-100",
    playerId: "player-100",
    roundId: "round-100",
    gameId: "game-100",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "50.00", currency: "BRL" }),
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  });

  describe("Invariants in create", () => {
    it("should create transaction in PENDING status with valid properties", () => {
      const tx = WagerTransaction.create(createValidProps());

      expect(tx.id).toBe("tx-100");
      expect(tx.providerId).toBe("provider-a");
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.referenceAttempts).toBe(0);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
      expect(tx.referenceTransactionId).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
      expect(tx.observedBalance).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.isTerminal()).toBe(false);
    });

    it("should reject creation with empty required string fields", () => {
      const requiredFields = [
        "id",
        "providerId",
        "externalTransactionId",
        "idempotencyKey",
        "payloadHash",
        "walletId",
        "playerId",
        "roundId",
        "gameId",
      ] as const;

      for (const field of requiredFields) {
        expect(() => {
          WagerTransaction.create(createValidProps({ [field]: "" }));
        }).toThrow(InvalidTransactionStateError);
      }
    });
    it("should reject creation when text fields exceed maximum length limits", () => {
      const fieldsUpTo128 = ["providerId", "playerId", "roundId", "gameId"] as const;
      for (const field of fieldsUpTo128) {
        expect(() => {
          WagerTransaction.create(createValidProps({ [field]: "a".repeat(129) }));
        }).toThrow(InvalidTransactionStateError);
      }

      const fieldsUpTo255 = ["externalTransactionId", "idempotencyKey"] as const;
      for (const field of fieldsUpTo255) {
        expect(() => {
          WagerTransaction.create(createValidProps({ [field]: "b".repeat(256) }));
        }).toThrow(InvalidTransactionStateError);
      }

      expect(() => {
        WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: "c".repeat(256),
          }),
        );
      }).toThrow(InvalidTransactionStateError);
    });


    it("should require referenceExternalTransactionId for REFUND and ROLLBACK", () => {
      expect(() => {
        WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Refund }));
      }).toThrow(InvalidTransactionStateError);

      expect(() => {
        WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Rollback }));
      }).toThrow(InvalidTransactionStateError);

      const refundTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "ext-bet-100",
        }),
      );
      expect(refundTx.referenceExternalTransactionId).toBe("ext-bet-100");
    });

    it("should require positive money for all kinds except LOSS, which accepts zero", () => {
      expect(() => {
        WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Bet,
            money: Money.zero("BRL"),
          }),
        );
      }).toThrow(InvalidTransactionStateError);

      expect(() => {
        WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Win,
            money: Money.zero("BRL"),
          }),
        );
      }).toThrow(InvalidTransactionStateError);

      const lossZero = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Loss,
          money: Money.zero("BRL"),
        }),
      );
      expect(lossZero.money.amount).toBe("0.00");

      const lossPositive = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Loss,
          money: Money.from({ amount: "10.00", currency: "BRL" }),
        }),
      );
      expect(lossPositive.money.amount).toBe("10.00");
    });
  });

  describe("Rehydration", () => {
    it("should rehydrate transaction exactly with persisted state without revalidation", () => {
      const processedAt = new Date("2026-07-29T12:05:00Z");
      const tx = WagerTransaction.rehydrate({
        id: "tx-rehydrated",
        providerId: "provider-b",
        externalTransactionId: "ext-200",
        idempotencyKey: "provider-b:ext-200",
        payloadHash: "hash-999",
        walletId: "wallet-200",
        playerId: "player-200",
        roundId: "round-200",
        gameId: "game-200",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
        createdAt: new Date("2026-07-29T12:00:00Z"),
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: undefined,
        failureCode: undefined,
        processedAt,
        observedBalance: Money.from({ amount: "500.00", currency: "BRL" }),
        referenceAttempts: 3,
        nextReferenceAttemptAt: undefined,
      });

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.observedBalance?.amount).toBe("500.00");
      expect(tx.referenceAttempts).toBe(3);
    });
  });

  describe("State Transitions Matrix", () => {
    const createTx = () => WagerTransaction.create(createValidProps());

    it("should allow PENDING to PROCESSED", () => {
      const tx = createTx();
      const at = new Date("2026-07-29T12:01:00Z");
      const observed = Money.from({ amount: "950.00", currency: "BRL" });

      tx.markProcessed("ref-uuid-1", observed, at);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe("ref-uuid-1");
      expect(tx.observedBalance?.equals(observed)).toBe(true);
      expect(tx.processedAt).toBe(at);
      expect(tx.isTerminal()).toBe(true);
    });

    it("should allow PENDING to PENDING_REFERENCE and retry scheduling", () => {
      const tx = createTx();
      const nextAttempt = new Date("2026-07-29T12:02:00Z");

      tx.markPendingReference(undefined, nextAttempt);

      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      expect(tx.nextReferenceAttemptAt).toBe(nextAttempt);
      expect(tx.referenceAttempts).toBe(0);
      expect(tx.isTerminal()).toBe(false);

      const retryAttempt = new Date("2026-07-29T12:04:00Z");
      tx.scheduleReferenceRetry(retryAttempt);

      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toBe(retryAttempt);
    });

    it("should allow PENDING_REFERENCE to PROCESSED", () => {
      const tx = createTx();
      tx.markPendingReference();
      tx.scheduleReferenceRetry(new Date());

      const observed = Money.from({ amount: "1200.00", currency: "BRL" });
      tx.markProcessed("ref-uuid-2", observed);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.observedBalance?.equals(observed)).toBe(true);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it("should allow PENDING to REJECTED", () => {
      const tx = createTx();
      const observed = Money.from({ amount: "30.00", currency: "BRL" });

      tx.reject(FailureCode.InsufficientFunds, observed);

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.observedBalance?.equals(observed)).toBe(true);
      expect(tx.isTerminal()).toBe(true);
    });

    it("should allow PENDING_REFERENCE to REJECTED", () => {
      const tx = createTx();
      tx.markPendingReference();

      tx.reject(FailureCode.ReferenceNotFound);

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(tx.isTerminal()).toBe(true);
    });

    it("should allow PENDING to FAILED and PENDING_REFERENCE to FAILED", () => {
      const tx1 = createTx();
      tx1.fail(FailureCode.PermanentInfrastructureError);
      expect(tx1.status).toBe(WagerTransactionStatus.Failed);
      expect(tx1.failureCode).toBe(FailureCode.PermanentInfrastructureError);
      expect(tx1.isTerminal()).toBe(true);

      const tx2 = createTx();
      tx2.markPendingReference();
      tx2.fail(FailureCode.PermanentInfrastructureError);
      expect(tx2.status).toBe(WagerTransactionStatus.Failed);
      expect(tx2.isTerminal()).toBe(true);
    });

    it("should reject invalid transitions from terminal states", () => {
      const terminalStatuses = [
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
        WagerTransactionStatus.Failed,
      ];

      for (const terminal of terminalStatuses) {
        const tx = WagerTransaction.rehydrate({
          ...createValidProps(),
          status: terminal,
          createdAt: new Date(),
          referenceAttempts: 0,
        });

        expect(tx.isTerminal()).toBe(true);
        expect(() => tx.markProcessed("ref", Money.zero("BRL"))).toThrow(InvalidTransactionStateError);
        expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
        expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
        expect(() => tx.fail()).toThrow(InvalidTransactionStateError);
        expect(() => tx.scheduleReferenceRetry(new Date())).toThrow(InvalidTransactionStateError);
      }
    });

    it("should reject invalid transition PENDING_REFERENCE to PENDING_REFERENCE via markPendingReference", () => {
      const tx = createTx();
      tx.markPendingReference();
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    });
  });


  describe("Domain Queries", () => {
    it("should correctly report affectsBalance", () => {
      const betTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Bet }));
      const winTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Win }));
      const refundTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "ref-1",
        }),
      );
      const rollbackTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: "ref-2",
        }),
      );
      const lossTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Loss,
          money: Money.zero("BRL"),
        }),
      );

      expect(betTx.affectsBalance()).toBe(true);
      expect(winTx.affectsBalance()).toBe(true);
      expect(refundTx.affectsBalance()).toBe(true);
      expect(rollbackTx.affectsBalance()).toBe(true);
      expect(lossTx.affectsBalance()).toBe(false);
    });

    it("should correctly report requiresReference", () => {
      const betTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Bet }));
      const refundTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "ref-1",
        }),
      );
      const rollbackTx = WagerTransaction.create(
        createValidProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: "ref-2",
        }),
      );

      expect(betTx.requiresReference()).toBe(false);
      expect(refundTx.requiresReference()).toBe(true);
      expect(rollbackTx.requiresReference()).toBe(true);
    });

    it("should correctly verify matchesPayload", () => {
      const tx = WagerTransaction.create(createValidProps({ payloadHash: "hash-abc-123" }));

      expect(tx.matchesPayload("hash-abc-123")).toBe(true);
      expect(tx.matchesPayload("other-hash")).toBe(false);
    });

    describe("ledgerDirectionFor", () => {
      it("should return DEBIT for BET", () => {
        const betTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Bet }));
        expect(betTx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      });

      it("should return CREDIT for WIN, REFUND and OPENING", () => {
        const winTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Win }));
        const refundTx = WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: "ref",
          }),
        );
        const openingTx = WagerTransaction.create(
          createValidProps({ kind: WagerTransactionKind.Opening }),
        );

        expect(winTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
        expect(refundTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
        expect(openingTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      });

      it("should return opposite direction for ROLLBACK depending on reference", () => {
        const betTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Bet }));
        const winTx = WagerTransaction.create(createValidProps({ kind: WagerTransactionKind.Win }));
        const refundTx = WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: "ref",
          }),
        );

        const rollbackTx = WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Rollback,
            referenceExternalTransactionId: "ref",
          }),
        );

        expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
        expect(rollbackTx.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
        expect(rollbackTx.ledgerDirectionFor(refundTx)).toBe(LedgerDirection.Debit);
      });

      it("should throw when determining ledgerDirectionFor ROLLBACK without reference", () => {
        const rollbackTx = WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Rollback,
            referenceExternalTransactionId: "ref",
          }),
        );
        expect(() => rollbackTx.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
      });

      it("should throw when requesting ledgerDirectionFor LOSS", () => {
        const lossTx = WagerTransaction.create(
          createValidProps({
            kind: WagerTransactionKind.Loss,
            money: Money.zero("BRL"),
          }),
        );
        expect(() => lossTx.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
      });
    });
  });
});


