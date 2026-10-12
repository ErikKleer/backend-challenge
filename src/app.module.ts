import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import config from "../mikro-orm.config";
import { AuthModule } from "./auth/auth.module";
import { PresentationModule } from "./shared/presentation/presentation.module";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    ObservabilityModule.forRoot(),
    AuthModule,
    PresentationModule,
  ],
})
class AppModuleCore {}

export const AppModule = AppModuleCore;
