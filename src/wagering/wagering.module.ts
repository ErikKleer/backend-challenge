import { Module } from "@nestjs/common";
import { envSchema } from "../shared/infrastructure/config/env.config";
import {
  PENDING_REFERENCE_POLICY_TOKEN,
  type PendingReferencePolicy,
} from "./application/pending-reference-policy";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case";
import { WagerSettlementService } from "./application/wager-settlement.service";
import { ProviderTransactionsController } from "./presentation/provider-transactions.controller";
import { WageringController } from "./presentation/wagering.controller";

const pendingReferenceEnvSchema = envSchema.pick({
  PENDING_REFERENCE_BASE_DELAY_MS: true,
  PENDING_REFERENCE_MAX_DELAY_MS: true,
  PENDING_REFERENCE_MAX_ATTEMPTS: true,
});

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
  ],
  exports: [SubmitWagerTransactionUseCase, WagerSettlementService],
})
export class WageringModule {}
