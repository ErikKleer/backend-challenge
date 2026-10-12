import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../shared/domain/money";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";
import type { ReconciliationRepository } from "../../application/reconciliation.repository.port";
import type { WalletReconciliationSnapshot } from "../../domain/wallet-reconciliation";

interface SnapshotRow {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  checkedEntries: string;
}

export class MikroOrmReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly rootEm?: EntityManager) {}

  private get em(): EntityManager {
    try {
      return MikroOrmUnitOfWork.getCurrentEntityManager();
    } catch (err) {
      if (this.rootEm) return this.rootEm;
      throw err;
    }
  }

  public async snapshot(walletId: string): Promise<WalletReconciliationSnapshot | null> {
    try {
      // A soma é feita pelo PostgreSQL em `numeric`, sem passar por `number`.
      const rows = await this.em.execute<SnapshotRow[]>(
        `SELECT w.currency,
                w.balance::text AS "storedBalance",
                COALESCE(
                  (SELECT SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END)
                     FROM wallet_ledger_entries l
                    WHERE l.wallet_id = w.id),
                  0
                )::numeric(19,2)::text AS "calculatedBalance",
                (SELECT COUNT(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)::text AS "checkedEntries"
           FROM wallets w
          WHERE w.id = ?`,
        [walletId],
      );

      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        walletId,
        storedBalance: Money.from({ amount: row.storedBalance, currency: row.currency }),
        calculatedBalance: Money.from({ amount: row.calculatedBalance, currency: row.currency }),
        checkedEntries: Number(row.checkedEntries),
      };
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }
}
