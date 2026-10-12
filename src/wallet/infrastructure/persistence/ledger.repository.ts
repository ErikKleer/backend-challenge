import type { EntityManager } from "@mikro-orm/postgresql";
import type { LedgerRepository } from "../../application/ledger.repository.port";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletLedgerEntryRow } from "./wallet-ledger-entry.entity-schema";
import { WalletLedgerEntryPersistenceMapper } from "./wallet-ledger-entry.mapper";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly rootEm?: EntityManager) {}

  private get em(): EntityManager {
    try {
      return MikroOrmUnitOfWork.getCurrentEntityManager();
    } catch (err) {
      if (this.rootEm) return this.rootEm;
      throw err;
    }
  }

  /**
   * Insere um lançamento contábil no ledger imutável.
   * Não fornece APIs nem caminhos para update ou delete.
   */
  public async append(entry: WalletLedgerEntry): Promise<void> {
    try {
      const row = WalletLedgerEntryPersistenceMapper.toRow(entry);

      await this.em.execute(
        `INSERT INTO wallet_ledger_entries (
          id,
          wallet_id,
          transaction_id,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          wallet_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.walletId,
          row.transactionId,
          row.direction,
          row.amount,
          row.currency,
          row.balanceBefore,
          row.balanceAfter,
          row.walletVersion,
          row.createdAt,
        ],
      );
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async findPage(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    try {
      const rows = await this.em.execute<WalletLedgerEntryRow[]>(
        `SELECT id,
                wallet_id AS "walletId",
                transaction_id AS "transactionId",
                direction,
                amount::text AS amount,
                currency,
                balance_before::text AS "balanceBefore",
                balance_after::text AS "balanceAfter",
                wallet_version AS "walletVersion",
                created_at AS "createdAt"
           FROM wallet_ledger_entries
          WHERE wallet_id = ? AND wallet_version > ?
          ORDER BY wallet_version
          LIMIT ?`,
        [walletId, afterVersion, limit],
      );
      return rows.map((row) => WalletLedgerEntryPersistenceMapper.toDomain(row));
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }
}
