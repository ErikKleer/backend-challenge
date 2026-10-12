import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import config from "../mikro-orm.config";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";

@Module({
  imports: [MikroOrmModule.forRoot(config), ObservabilityModule.forRoot()],
})
class AppModuleCore {}

export const AppModule = AppModuleCore;
