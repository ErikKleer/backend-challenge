import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface LedgerRepository {
  /**
   * Adiciona um lançamento contábil no livro-razão imutável (append-only).
   * Operações de update e delete são estritamente proibidas no contrato e no banco.
   */
  append(entry: WalletLedgerEntry): Promise<void>;
}

export const LEDGER_REPOSITORY_TOKEN = Symbol("LedgerRepository");
