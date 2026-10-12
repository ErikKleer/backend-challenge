import { Inject } from "@nestjs/common";
import { CLOCK_TOKEN, type Clock } from "../../shared/application/clock.port";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../shared/application/id-generator.port";
import { UNIT_OF_WORK_TOKEN, type UnitOfWork } from "../../shared/application/unit-of-work.port";
import { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import { bindContext, runWithContext } from "../../shared/infrastructure/observability/execution-context";
import {
  MetricsService,
  type ProcessingOutcome,
} from "../../shared/infrastructure/observability/metrics.service";
import { TransientInfrastructureError } from "../../shared/infrastructure/persistence/postgres-errors";
import { WagerTransactionStatus } from "../domain/wager-transaction-types";
import { WagerSettlementService } from "./wager-settlement.service";
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepository,
} from "./wager-transaction.repository.port";

export interface PendingReferenceReprocessorOptions {
  /** Teto de transações por ciclo, para o worker devolver o controle ao laço. */
  batchSize: number;
}

export const PENDING_REFERENCE_REPROCESSOR_OPTIONS_TOKEN = Symbol("PendingReferenceReprocessorOptions");

const OUTCOME_BY_STATUS: Readonly<Partial<Record<WagerTransactionStatus, ProcessingOutcome>>> = {
  [WagerTransactionStatus.Processed]: "processed",
  [WagerTransactionStatus.Rejected]: "rejected",
  [WagerTransactionStatus.PendingReference]: "pending_reference",
};

/**
 * Um ciclo de reprocessamento das transações em `PENDING_REFERENCE` vencidas.
 *
 * Cada transação roda na sua própria transação SQL:
 *
 *   claim (FOR UPDATE SKIP LOCKED, limit 1) → relê o status → `WagerSettlementService.settle`
 *   (lock da wallet, `decide`, saldo, ledger, outbox) → commit
 *
 * É o mesmo passo de liquidação da submissão, sem regra duplicada. Uma falha desfaz só a
 * transação em curso, que continua pendente e vencida para o próximo ciclo.
 */
export class PendingReferenceReprocessor {
  constructor(
    @Inject(UNIT_OF_WORK_TOKEN) private readonly unitOfWork: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN) private readonly transactions: WagerTransactionRepository,
    @Inject(WagerSettlementService) private readonly settlement: WagerSettlementService,
    @Inject(ID_GENERATOR_TOKEN) private readonly ids: IdGenerator,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(PENDING_REFERENCE_REPROCESSOR_OPTIONS_TOKEN)
    private readonly options: PendingReferenceReprocessorOptions,
  ) {}

  /** Devolve quantas transações foram reclamadas; propaga a primeira falha do ciclo. */
  public async runOnce(): Promise<{ claimed: number }> {
    let claimed = 0;
    while (claimed < this.options.batchSize) {
      if (!(await this.reprocessNext())) {
        break;
      }
      claimed += 1;
    }
    return { claimed };
  }

  private reprocessNext(): Promise<boolean> {
    const correlationId = this.ids.generate();
    return runWithContext({ correlationId }, async () => {
      const stopTimer = this.metrics.startProcessingTimer("pending_worker");
      try {
        return await this.unitOfWork.run(() => this.reprocessClaimed(correlationId, stopTimer));
      } catch (error) {
        stopTimer(error instanceof TransientInfrastructureError ? "transient_failure" : "error");
        throw error;
      }
    });
  }

  private async reprocessClaimed(
    correlationId: string,
    stopTimer: (outcome: ProcessingOutcome) => number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const [claimed] = await this.transactions.findDuePendingReference(now, 1);
    if (!claimed) {
      return false;
    }

    // Relê o status já sob o lock da linha: outro caminho pode ter resolvido a transação
    const transaction = await this.transactions.findById(claimed.id);
    if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
      return true;
    }
    bindContext({
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
    });

    await this.settlement.settle(transaction, { correlationId, now });

    this.unitOfWork.afterCommit(() => {
      if (transaction.status === WagerTransactionStatus.PendingReference) {
        this.metrics.recordRetry("pending_worker", "pending_reference");
      } else {
        this.metrics.recordTransaction(transaction.kind, transaction.status, transaction.failureCode);
      }
      const seconds = stopTimer(OUTCOME_BY_STATUS[transaction.status] ?? "error");
      this.logger.info("pending reference reprocessed", {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        kind: transaction.kind,
        status: transaction.status,
        failureCode: transaction.failureCode,
        referenceAttempts: transaction.referenceAttempts,
        durationMs: Math.round(seconds * 1000),
      });
    });
    return true;
  }
}
