import { type DynamicModule, Module } from "@nestjs/common";
import {
  POSTGRES_READINESS_CHECK_TOKEN,
  type ReadinessCheck,
  SQS_READINESS_CHECK_TOKEN,
} from "../shared/application/readiness-check.port";
import { envSchema } from "../shared/infrastructure/config/env.config";
import { AppLogger } from "../shared/infrastructure/observability/app-logger";
import { HealthController } from "./health.controller";
import { ReadinessService } from "./readiness.service";

/**
 * Os checks vêm dos módulos donos de cada dependência (persistência e mensageria), que
 * exportam seus tokens; aqui só se compõe o relatório.
 */
@Module({})
export class HealthModule {
  public static forRoot(): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        {
          provide: ReadinessService,
          useFactory: (postgres: ReadinessCheck, sqs: ReadinessCheck, logger: AppLogger) =>
            new ReadinessService(
              [postgres, sqs],
              logger,
              envSchema.shape.HEALTH_CHECK_TIMEOUT_MS.parse(process.env.HEALTH_CHECK_TIMEOUT_MS),
            ),
          inject: [POSTGRES_READINESS_CHECK_TOKEN, SQS_READINESS_CHECK_TOKEN, AppLogger],
        },
      ],
    };
  }
}
