import { Inject } from "@nestjs/common";
import { WalletNotFoundError } from "../../shared/domain/domain.error";
import { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service";
import { WalletReconciliation } from "../domain/wallet-reconciliation";
import {
  RECONCILIATION_REPOSITORY_TOKEN,
  type ReconciliationRepository,
} from "./reconciliation.repository.port";

/**
 * Confere o saldo da wallet contra o ledger. Divergência **não** é corrigida: é
 * logada em nível de erro, contada em `reconciliation_divergences_total` e sinalizada
 * na resposta (`consistent: false`), para uma pessoa investigar.
 */
export class ReconcileWalletUseCase {
  constructor(
    @Inject(RECONCILIATION_REPOSITORY_TOKEN) private readonly reconciliations: ReconciliationRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public async execute(walletId: string): Promise<WalletReconciliation> {
    const snapshot = await this.reconciliations.snapshot(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }

    const result = WalletReconciliation.check(snapshot);
    if (!result.consistent) {
      this.metrics.recordReconciliationDivergence();
      // Sem valores monetários no log (política do AppLogger): só o sentido da divergência.
      this.logger.error("wallet reconciliation divergence", {
        walletId,
        checkedEntries: result.checkedEntries,
        divergence: result.difference.isPositive() ? "stored_above_ledger" : "stored_below_ledger",
      });
    }
    return result;
  }
}
