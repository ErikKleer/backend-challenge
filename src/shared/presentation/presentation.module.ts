import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AppLogger } from "../infrastructure/observability/app-logger";
import { AllExceptionsFilter } from "./all-exceptions.filter";

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (logger: AppLogger) => new AllExceptionsFilter(logger),
      inject: [AppLogger],
    },
  ],
})
export class PresentationModule {}
