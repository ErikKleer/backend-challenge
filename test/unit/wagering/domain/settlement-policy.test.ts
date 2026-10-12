import { describe, expect, it } from "bun:test";
import { Money } from "../../../../src/shared/domain/money";
import { LedgerDirection } from "../../../../src/wallet/domain/wallet-ledger-entry";
import { Wallet } from "../../../../src/wallet/domain/wallet";
import {
  SettlementDecision,
  SettlementPolicy,
} from "../../../../src/wagering/domain/settlement-policy";
import { WagerTransaction } from "../../../../src/wagering/domain/wager-transaction";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../../src/wagering/domain/wager-transaction-types";

describe("SettlementPolicy (Table-driven domain policy)", () => {
  const createWallet = (balanceAmount = "100.00", currency = "BRL", playerId = "player-1") => {
    return Wallet.open({
      id: "wallet-1",
      playerId,
      initialBalance: Money.from({ amount: balanceAmount, currency }),
    });
  };

  const createTx = (props: {
    kind: WagerTransactionKind;
    amount?: string;
    currency?: string;
    playerId?: string;
    walletId?: string;
    roundId?: string;
    referenceExternalTransactionId?: string;
  }) => {
    return WagerTransaction.create({
      id: "tx-op-1",
      providerId: "provider-a",
      externalTransactionId: "ext-op-1",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      walletId: props.walletId ?? "wallet-1",
      playerId: props.playerId ?? "player-1",
      roundId: props.roundId ?? "round-1",
      gameId: "game-1",
      kind: props.kind,
      money: Money.from({
        amount: props.amount ?? "50.00",
        currency: props.currency ?? "BRL",
      }),
      referenceExternalTransactionId: props.referenceExternalTransactionId,
    });
  };

  const createRef = (props: {
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    providerId?: string;
    amount?: string;
    currency?: string;
    playerId?: string;
    walletId?: string;
    roundId?: string;
  }) => {
    return WagerTransaction.rehydrate({
      id: "tx-ref-1",
      providerId: props.providerId ?? "provider-a",
      externalTransactionId: "ext-ref-1",
      idempotencyKey: "key-ref",
      payloadHash: "hash-ref",
      walletId: props.walletId ?? "wallet-1",
      playerId: props.playerId ?? "player-1",
      roundId: props.roundId ?? "round-1",
      gameId: "game-1",
      kind: props.kind,
      money: Money.from({
        amount: props.amount ?? "50.00",
        currency: props.currency ?? "BRL",
      }),
      status: props.status,
      createdAt: new Date(),
      referenceAttempts: 0,
    });
  };

  describe("Rule 1: Currency and Player-Wallet Ownership", () => {
    it("should reject CURRENCY_MISMATCH when operation currency != wallet currency", () => {
      const wallet = createWallet("100.00", "BRL");
      const tx = createTx({ kind: WagerTransactionKind.Bet, currency: "USD" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "REJECT",
        code: FailureCode.CurrencyMismatch,
      });
    });

    it("should reject PLAYER_WALLET_MISMATCH when transaction playerId != wallet playerId", () => {
      const wallet = createWallet("100.00", "BRL", "player-1");
      const tx = createTx({ kind: WagerTransactionKind.Bet, playerId: "other-player" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "REJECT",
        code: FailureCode.PlayerWalletMismatch,
      });
    });
  });

  describe("Rule 2: BET handling and Readme §8 Scenario", () => {
    it("should APPLY DEBIT when wallet has sufficient funds", () => {
      const wallet = createWallet("100.00", "BRL");
      const tx = createTx({ kind: WagerTransactionKind.Bet, amount: "80.00" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "APPLY",
        direction: LedgerDirection.Debit,
        money: tx.money,
      });
    });

    it("should REJECT INSUFFICIENT_FUNDS when BET exceeds wallet balance (Readme §8)", () => {
      const wallet = createWallet("20.00", "BRL");
      const tx = createTx({ kind: WagerTransactionKind.Bet, amount: "80.00" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "REJECT",
        code: FailureCode.InsufficientFunds,
      });
    });
  });

  describe("Rule 3: WIN and LOSS without reference", () => {
    it("should APPLY CREDIT for standalone WIN", () => {
      const wallet = createWallet("100.00", "BRL");
      const tx = createTx({ kind: WagerTransactionKind.Win, amount: "200.00" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "APPLY",
        direction: LedgerDirection.Credit,
        money: tx.money,
      });
    });

    it("should return NO_BALANCE_EFFECT for standalone LOSS", () => {
      const wallet = createWallet("100.00", "BRL");
      const tx = createTx({ kind: WagerTransactionKind.Loss, amount: "0.00" });

      const decision = SettlementPolicy.decide({ transaction: tx, wallet });
      expect(decision).toEqual({
        type: "NO_BALANCE_EFFECT",
      });
    });
  });

  describe("Rule 4: Reference Resolution, Pending and Failed states", () => {
    it("should return PENDING_REFERENCE when reference is missing", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      const decision = SettlementPolicy.decide({
        transaction: refundTx,
        wallet,
        reference: undefined,
      });
      expect(decision).toEqual({ type: "PENDING_REFERENCE" });
    });

    it("should return PENDING_REFERENCE when reference is PENDING or PENDING_REFERENCE", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      const refPending = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Pending,
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refPending }),
      ).toEqual({ type: "PENDING_REFERENCE" });

      const refPendingRef = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.PendingReference,
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refPendingRef }),
      ).toEqual({ type: "PENDING_REFERENCE" });
    });

    it("should REJECT REFERENCE_NOT_PROCESSED when reference is REJECTED or FAILED", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      const refRejected = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Rejected,
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refRejected }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceNotProcessed });

      const refFailed = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Failed,
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refFailed }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceNotProcessed });
    });

    it("should REJECT REFERENCE_MISMATCH when provider, player, wallet, currency or round differs", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      // Outro provider
      const refProviderMismatch = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
        providerId: "another-provider",
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refProviderMismatch }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceMismatch });

      // Outro player
      const refPlayerMismatch = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
        playerId: "another-player",
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refPlayerMismatch }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceMismatch });

      // Outra wallet
      const refWalletMismatch = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
        walletId: "another-wallet",
      });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refWalletMismatch }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceMismatch });
    });
  });

  describe("Rule 5 & 6: Allowed Reference Kinds and Exact Amount Matching", () => {
    it("should allow REFUND referencing only BET and reject any other kind", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      const refWin = createRef({ kind: WagerTransactionKind.Win, status: WagerTransactionStatus.Processed });
      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refWin }),
      ).toEqual({ type: "REJECT", code: FailureCode.InvalidReferenceKind });
    });

    it("should allow ROLLBACK referencing BET, WIN or REFUND", () => {
      const wallet = createWallet("200.00");
      const rollbackTx = createTx({
        kind: WagerTransactionKind.Rollback,
        amount: "50.00",
        referenceExternalTransactionId: "ext-ref-1",
      });

      const refBet = createRef({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed, amount: "50.00" });
      expect(
        SettlementPolicy.decide({ transaction: rollbackTx, wallet, reference: refBet }),
      ).toEqual({ type: "APPLY", direction: LedgerDirection.Credit, money: rollbackTx.money });

      const refWin = createRef({ kind: WagerTransactionKind.Win, status: WagerTransactionStatus.Processed, amount: "50.00" });
      expect(
        SettlementPolicy.decide({ transaction: rollbackTx, wallet, reference: refWin }),
      ).toEqual({ type: "APPLY", direction: LedgerDirection.Debit, money: rollbackTx.money });
    });

    it("should REJECT REFERENCE_AMOUNT_MISMATCH when amounts do not match exactly", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        amount: "40.00",
        referenceExternalTransactionId: "ext-ref-1",
      });

      const refBet = createRef({
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
        amount: "50.00",
      });

      expect(
        SettlementPolicy.decide({ transaction: refundTx, wallet, reference: refBet }),
      ).toEqual({ type: "REJECT", code: FailureCode.ReferenceAmountMismatch });
    });
  });

  describe("Rule 7 & 8: Reversal Invariants and Overdraw Prevention", () => {
    it("should REJECT ALREADY_REVERSED if existingReversal is present", () => {
      const wallet = createWallet();
      const refundTx = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });
      const refBet = createRef({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed });
      const previousReversal = createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-ref-1",
      });

      const decision = SettlementPolicy.decide({
        transaction: refundTx,
        wallet,
        reference: refBet,
        existingReversal: previousReversal,
      });

      expect(decision).toEqual({ type: "REJECT", code: FailureCode.AlreadyReversed });
    });

    it("should REJECT REVERSAL_WOULD_OVERDRAW when reversal debit exceeds wallet balance (distinct from Bet INSUFFICIENT_FUNDS)", () => {
      // Carteira possui apenas 30.00 BRL
      const wallet = createWallet("30.00", "BRL");
      const rollbackTx = createTx({
        kind: WagerTransactionKind.Rollback,
        amount: "50.00",
        referenceExternalTransactionId: "ext-ref-1",
      });
      // A referência era um WIN de 50.00 (que deu crédito). O ROLLBACK é um débito de 50.00!
      const refWin = createRef({
        kind: WagerTransactionKind.Win,
        status: WagerTransactionStatus.Processed,
        amount: "50.00",
      });

      const decision = SettlementPolicy.decide({
        transaction: rollbackTx,
        wallet,
        reference: refWin,
      });

      expect(decision).toEqual({
        type: "REJECT",
        code: FailureCode.ReversalWouldOverdraw,
      });
    });
  });
});
