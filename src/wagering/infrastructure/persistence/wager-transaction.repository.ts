import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../application/wager-transaction.repository.port";
import type { WagerTransaction } from "../../domain/wager-transaction";
import { type WagerTransactionRow } from "./wager-transaction.entity-schema";
import { WagerTransactionPersistenceMapper } from "./wager-transaction.mapper";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";

const SELECT_COLS = `
  id,
  provider_id as "providerId",
  external_transaction_id as "externalTransactionId",
  idempotency_key as "idempotencyKey",
  payload_hash as "payloadHash",
  wallet_id as "walletId",
  player_id as "playerId",
  round_id as "roundId",
  game_id as "gameId",
  kind,
  status,
  amount,
  currency,
  reference_external_transaction_id as "referenceExternalTransactionId",
  reference_transaction_id as "referenceTransactionId",
  failure_code as "failureCode",
  observed_balance as "observedBalance",
  reference_attempts as "referenceAttempts",
  next_reference_attempt_at as "nextReferenceAttemptAt",
  created_at as "createdAt",
  processed_at as "processedAt",
  updated_at as "updatedAt"
`;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly rootEm?: EntityManager) {}

  private get em(): EntityManager {
    try {
      return MikroOrmUnitOfWork.getCurrentEntityManager();
    } catch (err) {
      if (this.rootEm) return this.rootEm;
      throw err;
    }
  }

  public async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    try {
      const row = WagerTransactionPersistenceMapper.toRow(transaction);
      const res = await this.em.execute<Array<{ id: string }>>(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_external_transaction_id, reference_transaction_id, failure_code,
          observed_balance, reference_attempts, next_reference_attempt_at,
          created_at, processed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
          row.id, row.providerId, row.externalTransactionId, row.idempotencyKey,
          row.payloadHash, row.walletId, row.playerId, row.roundId, row.gameId,
          row.kind, row.status, row.amount, row.currency,
          row.referenceExternalTransactionId, row.referenceTransactionId,
          row.failureCode, row.observedBalance, row.referenceAttempts,
          row.nextReferenceAttemptAt, row.createdAt, row.processedAt, row.updatedAt,
        ],
      );
      return Boolean(res && res.length > 0);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findById(id: string): Promise<WagerTransaction | null> {
    try {
      const rows = await this.em.execute<WagerTransactionRow[]>(
        `SELECT ${SELECT_COLS} FROM wager_transactions WHERE id = ?`,
        [id],
      );
      if (!rows || rows.length === 0 || !rows[0]) return null;
      return WagerTransactionPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    try {
      const rows = await this.em.execute<WagerTransactionRow[]>(
        `SELECT ${SELECT_COLS} FROM wager_transactions WHERE idempotency_key = ?`,
        [key],
      );
      if (!rows || rows.length === 0 || !rows[0]) return null;
      return WagerTransactionPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    try {
      const rows = await this.em.execute<WagerTransactionRow[]>(
        `SELECT ${SELECT_COLS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
        [providerId, externalTransactionId],
      );
      if (!rows || rows.length === 0 || !rows[0]) return null;
      return WagerTransactionPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null> {
    try {
      const rows = await this.em.execute<WagerTransactionRow[]>(
        `SELECT ${SELECT_COLS} FROM wager_transactions
         WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`,
        [referenceTransactionId],
      );
      if (!rows || rows.length === 0 || !rows[0]) return null;
      return WagerTransactionPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("findDuePendingReference limit must be a positive integer");
    }
    try {
      const rows = await this.em.execute<WagerTransactionRow[]>(
        `SELECT ${SELECT_COLS} FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
         ORDER BY next_reference_attempt_at ASC, id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return (rows ?? []).map((row) => WagerTransactionPersistenceMapper.toDomain(row));
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async save(transaction: WagerTransaction, at: Date): Promise<void> {
    try {
      const row = WagerTransactionPersistenceMapper.toRow(transaction, at);
      await this.em.execute(
        `UPDATE wager_transactions
         SET status = ?, failure_code = ?, reference_transaction_id = ?, observed_balance = ?,
             reference_attempts = ?, next_reference_attempt_at = ?, processed_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          row.status, row.failureCode, row.referenceTransactionId, row.observedBalance,
          row.referenceAttempts, row.nextReferenceAttemptAt, row.processedAt, row.updatedAt,
          row.id,
        ],
      );
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }
}
