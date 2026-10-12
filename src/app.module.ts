import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import config from "../mikro-orm.config";
import { AuthModule } from "./auth/auth.module";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    ObservabilityModule.forRoot(),
    AuthModule,
  ],
})
class AppModuleCore {}

export const AppModule = AppModuleCore;
