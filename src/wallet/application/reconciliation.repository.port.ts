import type { WalletReconciliationSnapshot } from "../domain/wallet-reconciliation";

export interface ReconciliationRepository {
  /**
   * Lê, num **único statement**, o saldo guardado da wallet e a soma/contagem do ledger.
   * Um statement vê um único snapshot do banco, então saldo e ledger não se desencontram
   * por um commit concorrente entre duas leituras. Não toma lock. Retorna null se a
   * wallet não existe.
   */
  snapshot(walletId: string): Promise<WalletReconciliationSnapshot | null>;
}

export const RECONCILIATION_REPOSITORY_TOKEN = Symbol("ReconciliationRepository");
