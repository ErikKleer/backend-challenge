import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { UuidV7IdGenerator } from "../id/uuid-v7-id-generator";
import { createCorrelationIdMiddleware } from "./correlation-id.middleware";

@Module({})
export class ObservabilityModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createCorrelationIdMiddleware(new UuidV7IdGenerator()))
      .forRoutes("*");
  }
}
