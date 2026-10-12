import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { UuidV7IdGenerator } from "../id/uuid-v7-id-generator";
import { envSchema } from "../config/env.config";
import { AppLogger, type AppLoggerOptions } from "./app-logger";
import { createCorrelationIdMiddleware } from "./correlation-id.middleware";
import { HttpAccessLogInterceptor } from "./http-access-log.interceptor";

@Module({})
export class ObservabilityModule implements NestModule {
  /**
   * `overrides` existe para os testes redirecionarem as linhas de log; em
   * produção o nível vem de `LOG_LEVEL` e o destino é stdout.
   */
  public static forRoot(overrides: Partial<AppLoggerOptions> = {}): DynamicModule {
    return {
      module: ObservabilityModule,
      global: true,
      providers: [
        {
          provide: AppLogger,
          useFactory: () =>
            new AppLogger({
              level: envSchema.shape.LOG_LEVEL.parse(process.env.LOG_LEVEL),
              ...overrides,
            }),
        },
        {
          provide: APP_INTERCEPTOR,
          useFactory: (logger: AppLogger) => new HttpAccessLogInterceptor(logger),
          inject: [AppLogger],
        },
      ],
      exports: [AppLogger],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createCorrelationIdMiddleware(new UuidV7IdGenerator()))
      .forRoutes("*");
  }
}
