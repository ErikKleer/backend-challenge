import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./shared/infrastructure/config/env.config";
import { AppLogger } from "./shared/infrastructure/observability/app-logger";

async function bootstrap() {
  const config = loadConfig();
  // bufferLogs segura os logs do boot até o AppLogger JSON assumir.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  logger.info("application started", { port: config.PORT });
}

bootstrap();
