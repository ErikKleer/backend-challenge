import { expect } from "bun:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import { MikroOrmReconciliationRepository } from "../../src/wallet/infrastructure/persistence/reconciliation.repository";
import { WalletReconciliation } from "../../src/wallet/domain/wallet-reconciliation";

/** Executor de SQL cru: `orm.em` ou um EntityManager transacional. */
export type SqlExecutor = Pick<EntityManager, "execute">;

interface WalletSummaryRow {
  balance: string;
  version: number;
  ledger_sum: string;
  entry_count: string;
  last_balance_after: string | null;
  max_version: number | null;
}

/**
 * Invariante contábil central (README §6.2): o saldo da wallet é exatamente a soma do
 * seu ledger. Também confere que o último `balance_after` e a última `wallet_version`
 * do ledger coincidem com o estado da wallet. A soma é feita pelo PostgreSQL em
 * `numeric`, sem passar por `number`.
 */
export async function assertLedgerMatchesBalance(
  walletId: string,
  db: SqlExecutor,
): Promise<void> {
  const rows = await db.execute<WalletSummaryRow[]>(
    `SELECT w.balance::text AS balance,
            w.version,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS ledger_sum,
            COUNT(l.id)::text AS entry_count,
            (SELECT l2.balance_after::text FROM wallet_ledger_entries l2
              WHERE l2.wallet_id = w.id ORDER BY l2.wallet_version DESC LIMIT 1) AS last_balance_after,
            MAX(l.wallet_version) AS max_version
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.id`,
    [walletId],
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Wallet '${walletId}' not found while checking ledger invariants`);
  }

  expect(Number(row.balance) >= 0).toBe(true);
  // Comparação de texto: `numeric(19,2)` sempre sai com 2 casas.
  expect(row.ledger_sum).toBe(row.balance);

  if (Number(row.entry_count) === 0) {
    expect(row.balance).toBe("0.00");
    expect(row.version).toBe(1);
    return;
  }
  expect(row.last_balance_after).toBe(row.balance);
  expect(row.max_version).toBe(row.version);
}

interface LedgerVersionRow {
  wallet_version: number;
  direction: string;
}

export interface LedgerShape {
  entries: number;
  debits: number;
  credits: number;
}

/**
 * `UNIQUE(wallet_id, wallet_version)` impede repetição; aqui confere-se que também não
 * há lacuna: as versões do ledger são exatamente 1..N, e N é a versão da wallet. Uma
 * lacuna indicaria uma escrita perdida ou uma atualização de saldo sem lançamento.
 */
export async function assertLedgerVersionsContiguous(
  walletId: string,
  db: SqlExecutor,
): Promise<LedgerShape> {
  const rows = await db.execute<LedgerVersionRow[]>(
    `SELECT wallet_version, direction
       FROM wallet_ledger_entries
      WHERE wallet_id = ?
      ORDER BY wallet_version`,
    [walletId],
  );
  const [wallet] = await db.execute<Array<{ version: number }>>(
    "SELECT version FROM wallets WHERE id = ?",
    [walletId],
  );

  expect(rows.map((row) => row.wallet_version)).toEqual(
    Array.from({ length: rows.length }, (_unused, index) => index + 1),
  );
  if (rows.length > 0) {
    expect(wallet?.version).toBe(rows.length);
  }
  return {
    entries: rows.length,
    debits: rows.filter((row) => row.direction === "DEBIT").length,
    credits: rows.filter((row) => row.direction === "CREDIT").length,
  };
}

/** Invariantes finais de todo teste de concorrência (README §13). */
export async function assertWalletInvariants(
  walletId: string,
  db: SqlExecutor,
): Promise<LedgerShape> {
  await assertLedgerMatchesBalance(walletId, db);
  return assertLedgerVersionsContiguous(walletId, db);
}

/**
 * Verificação transversal do fim de cada teste multiprocesso: **todas** as wallets do banco
 * têm saldo igual à soma do ledger (a mesma consulta do `GET /wallets/:id/reconciliation`),
 * versões de ledger sem lacuna e nenhuma divergência escondida em outra wallet. Devolve a
 * quantidade de wallets conferidas, para o teste garantir que não verificou um banco vazio.
 */
export async function assertAllWalletsConsistent(db: EntityManager): Promise<number> {
  const reconciliation = new MikroOrmReconciliationRepository(db);
  const wallets = await db.execute<Array<{ id: string }>>("SELECT id FROM wallets ORDER BY id");

  for (const { id } of wallets) {
    const snapshot = await reconciliation.snapshot(id);
    const result = WalletReconciliation.check(snapshot!);
    expect(`${id}:${result.difference.toJSON().amount}`).toBe(`${id}:0.00`);
    await assertWalletInvariants(id, db);
  }
  return wallets.length;
}

/** Nenhuma transação ficou em `PENDING` (inserção e liquidação são uma transação SQL só). */
export async function assertNoStuckTransactions(db: SqlExecutor): Promise<void> {
  const [row] = await db.execute<Array<{ n: string }>>(
    "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE status = 'PENDING'",
  );
  expect(row?.n).toBe("0");
}
