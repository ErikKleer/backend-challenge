import { Module } from "@nestjs/common";
import { envSchema } from "../shared/infrastructure/config/env.config";
import { AppLogger } from "../shared/infrastructure/observability/app-logger";
import {
  PENDING_REFERENCE_POLICY_TOKEN,
  type PendingReferencePolicy,
} from "./application/pending-reference-policy";
import {
  PENDING_REFERENCE_REPROCESSOR_OPTIONS_TOKEN,
  PendingReferenceReprocessor,
} from "./application/pending-reference.reprocessor";
import { PendingReferenceWorker } from "./application/pending-reference.worker";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case";
import { WagerSettlementService } from "./application/wager-settlement.service";
import { ProviderTransactionsController } from "./presentation/provider-transactions.controller";
import { WageringController } from "./presentation/wagering.controller";

const WAGERING_CONFIG_TOKEN = Symbol("WageringConfig");

const pendingReferenceEnvSchema = envSchema.pick({
  PENDING_REFERENCE_BASE_DELAY_MS: true,
  PENDING_REFERENCE_MAX_DELAY_MS: true,
  PENDING_REFERENCE_MAX_ATTEMPTS: true,
});

const pendingWorkerEnvSchema = envSchema.pick({
  ENABLE_PENDING_WORKER: true,
  PENDING_WORKER_POLL_INTERVAL_MS: true,
  PENDING_WORKER_BATCH_SIZE: true,
});

type PendingWorkerConfig = ReturnType<typeof pendingWorkerEnvSchema.parse>;

@Module({
  controllers: [WageringController, ProviderTransactionsController],
  providers: [
    {
      provide: PENDING_REFERENCE_POLICY_TOKEN,
      useFactory: (): PendingReferencePolicy => {
        const env = pendingReferenceEnvSchema.parse(process.env);
        return {
          baseDelayMs: env.PENDING_REFERENCE_BASE_DELAY_MS,
          maxDelayMs: env.PENDING_REFERENCE_MAX_DELAY_MS,
          maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
        };
      },
    },
    WagerSettlementService,
    SubmitWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    // Leitura preguiçosa, como nos demais papéis: testes de API não têm o ambiente completo
    { provide: WAGERING_CONFIG_TOKEN, useFactory: () => pendingWorkerEnvSchema.parse(process.env) },
    {
      provide: PENDING_REFERENCE_REPROCESSOR_OPTIONS_TOKEN,
      useFactory: (config: PendingWorkerConfig) => ({ batchSize: config.PENDING_WORKER_BATCH_SIZE }),
      inject: [WAGERING_CONFIG_TOKEN],
    },
    PendingReferenceReprocessor,
    {
      provide: PendingReferenceWorker,
      useFactory: (
        reprocessor: PendingReferenceReprocessor,
        logger: AppLogger,
        config: PendingWorkerConfig,
      ) =>
        new PendingReferenceWorker(reprocessor, logger, {
          enabled: config.ENABLE_PENDING_WORKER,
          pollIntervalMs: config.PENDING_WORKER_POLL_INTERVAL_MS,
          batchSize: config.PENDING_WORKER_BATCH_SIZE,
        }),
      inject: [PendingReferenceReprocessor, AppLogger, WAGERING_CONFIG_TOKEN],
    },
  ],
  exports: [SubmitWagerTransactionUseCase, WagerSettlementService],
})
export class WageringModule {}
