import type { EntityManager } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../application/wallet.repository.port";
import type { Wallet } from "../../domain/wallet";
import { WalletEntitySchema, type WalletRow } from "./wallet.entity-schema";
import { WalletPersistenceMapper } from "./wallet.mapper";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { WalletVersionConflictError } from "../../../shared/infrastructure/persistence/postgres-errors";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly rootEm?: EntityManager,
    private readonly lockTimeoutMs: number = 2000,
  ) {}

  private get em(): EntityManager {
    try {
      return MikroOrmUnitOfWork.getCurrentEntityManager();
    } catch (err) {
      if (this.rootEm) {
        return this.rootEm;
      }
      throw err;
    }
  }

  public async findById(id: string): Promise<Wallet | null> {
    try {
      const rows = await this.em.execute<WalletRow[]>(
        `SELECT id, player_id as "playerId", currency, balance, version, created_at as "createdAt", updated_at as "updatedAt"
         FROM wallets
         WHERE id = ?`,
        [id],
      );

      if (!rows || rows.length === 0 || !rows[0]) {
        return null;
      }

      return WalletPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  /**
   * Lock de escrita na linha da wallet. Usa `FOR NO KEY UPDATE` (e não `FOR UPDATE`):
   * o `UPDATE` de saldo/versão não toca a chave, então esse modo basta para serializar
   * os escritores, e ele não conflita com o `FOR KEY SHARE` que o `INSERT` de uma
   * transação (FK para `wallets`) toma antes. Com `FOR UPDATE`, duas requisições da mesma
   * wallet que já inseriram a transação entram em deadlock ao pedir o lock.
   */
  public async findByIdForUpdate(id: string): Promise<Wallet | null> {
    try {
      // Garante que o lock_timeout da sessão local esteja ativo mesmo se invocado diretamente
      await this.em.execute(
        `SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms';`,
      );

      const rows = await this.em.execute<WalletRow[]>(
        `SELECT id, player_id as "playerId", currency, balance, version, created_at as "createdAt", updated_at as "updatedAt"
         FROM wallets
         WHERE id = ?
         FOR NO KEY UPDATE`,
        [id],
      );

      if (!rows || rows.length === 0 || !rows[0]) {
        return null;
      }

      return WalletPersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    try {
      const row = WalletPersistenceMapper.toRow(wallet);

      const result = await this.em.execute<Array<{ id: string }>>(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          row.id,
          row.playerId,
          row.currency,
          row.balance,
          row.version,
          row.createdAt,
          row.updatedAt,
        ],
      );

      return Boolean(result && result.length > 0);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    try {
      const row = WalletPersistenceMapper.toRow(wallet);

      const result = await this.em.execute<Array<{ id: string }>>(
        `UPDATE wallets
         SET balance = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
         RETURNING id`,
        [
          row.balance,
          row.version,
          row.updatedAt,
          row.id,
          expectedVersion,
        ],
      );

      if (!result || result.length === 0) {
        throw new WalletVersionConflictError(
          `Wallet ${wallet.id} balance update failed: expected version was ${expectedVersion}, but no rows were updated.`,
        );
      }
    } catch (error) {
      if (error instanceof WalletVersionConflictError) {
        throw error;
      }
      throw classifyPostgreSqlError(error);
    }
  }
}
