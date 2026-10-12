import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../../src/app.module";
import { ObservabilityModule } from "../../src/shared/infrastructure/observability/observability.module";
import { PersistenceModule } from "../../src/shared/infrastructure/persistence/persistence.module";
import type { TestDatabaseContext } from "./database";

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Sobe a API Nest real (porta efêmera) sobre o banco de teste da suíte. */
export async function startTestApi(db: TestDatabaseContext): Promise<TestApi> {
  @Module({
    imports: [
      PersistenceModule.forRoot(db.orm.em),
      ObservabilityModule.forRoot({ level: "silent" }),
      ApiModule,
    ],
  })
  class TestAppModule {}

  const app = await NestFactory.create(TestAppModule, { logger: false });
  await app.listen(0);
  return { app, baseUrl: await app.getUrl(), close: () => app.close() };
}
