import { Money } from "../../../shared/domain/money";
import { toDate, toOptionalDate } from "../../../shared/infrastructure/persistence/timestamps";
import {
  type FailureCode,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction-types";
import { WagerTransaction } from "../../domain/wager-transaction";
import type { WagerTransactionRow } from "./wager-transaction.entity-schema";

export class WagerTransactionPersistenceMapper {
  /**
   * Converte uma entidade de domínio WagerTransaction para o formato relacional WagerTransactionRow.
   */
  public static toRow(domain: WagerTransaction): WagerTransactionRow {
    return {
      id: domain.id,
      providerId: domain.providerId,
      externalTransactionId: domain.externalTransactionId,
      idempotencyKey: domain.idempotencyKey,
      payloadHash: domain.payloadHash,
      walletId: domain.walletId,
      playerId: domain.playerId,
      roundId: domain.roundId,
      gameId: domain.gameId,
      kind: domain.kind,
      status: domain.status,
      amount: domain.money.amount,
      currency: domain.money.currency,
      referenceExternalTransactionId: domain.referenceExternalTransactionId ?? null,
      referenceTransactionId: domain.referenceTransactionId ?? null,
      failureCode: domain.failureCode ?? null,
      observedBalance: domain.observedBalance ? domain.observedBalance.amount : null,
      referenceAttempts: domain.referenceAttempts,
      nextReferenceAttemptAt: domain.nextReferenceAttemptAt ?? null,
      createdAt: domain.createdAt,
      processedAt: domain.processedAt ?? null,
      updatedAt: domain.processedAt ?? domain.createdAt,
    };
  }

  /**
   * Reconstrói o agregado WagerTransaction a partir da linha do banco via rehydrate.
   */
  public static toDomain(row: WagerTransactionRow): WagerTransaction {
    const money = Money.from({ amount: row.amount, currency: row.currency });
    const observedBalance = row.observedBalance
      ? Money.from({ amount: row.observedBalance, currency: row.currency })
      : undefined;

    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      createdAt: toDate(row.createdAt),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: (row.failureCode as FailureCode) ?? undefined,
      processedAt: toOptionalDate(row.processedAt),
      observedBalance,
      referenceAttempts: row.referenceAttempts,
      nextReferenceAttemptAt: toOptionalDate(row.nextReferenceAttemptAt),
    });
  }
}

