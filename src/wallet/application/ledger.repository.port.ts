import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface LedgerRepository {
  /**
   * Adiciona um lançamento contábil no livro-razão imutável (append-only).
   * Operações de update e delete são estritamente proibidas no contrato e no banco.
   */
  append(entry: WalletLedgerEntry): Promise<void>;

  /**
   * Leitura paginada por `wallet_version` ascendente, sem lock:
   * `WHERE wallet_id = ? AND wallet_version > ? ORDER BY wallet_version LIMIT ?`.
   */
  findPage(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
}

export const LEDGER_REPOSITORY_TOKEN = Symbol("LedgerRepository");
