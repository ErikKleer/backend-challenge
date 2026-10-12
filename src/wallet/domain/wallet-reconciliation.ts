import type { Money } from "../../shared/domain/money";

export interface WalletReconciliationSnapshot {
  walletId: string;
  storedBalance: Money;
  /** Saldo reconstruído: soma dos créditos menos a soma dos débitos do ledger. */
  calculatedBalance: Money;
  checkedEntries: number;
}

/**
 * Resultado da conferência entre o saldo guardado na wallet e o reconstruído pelo
 * ledger. É só um relato: divergência nunca é corrigida aqui (README §9).
 */
export class WalletReconciliation {
  private constructor(
    public readonly walletId: string,
    public readonly storedBalance: Money,
    public readonly calculatedBalance: Money,
    /** `storedBalance - calculatedBalance`; positivo = wallet acima do ledger. */
    public readonly difference: Money,
    public readonly checkedEntries: number,
  ) {}

  public static check(snapshot: WalletReconciliationSnapshot): WalletReconciliation {
    return new WalletReconciliation(
      snapshot.walletId,
      snapshot.storedBalance,
      snapshot.calculatedBalance,
      snapshot.storedBalance.subtract(snapshot.calculatedBalance),
      snapshot.checkedEntries,
    );
  }

  get consistent(): boolean {
    return this.difference.isZero();
  }
}
